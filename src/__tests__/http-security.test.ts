/**
 * Phase 1 security tests for the HTTP server.
 *
 * Covers:
 *   1.1 — credentials bound to tenants (route-table sweep + cross-scope ceiling)
 *   1.2 — server-side startup posture warning (non-loopback + keyless)
 *   1.3 — sanitized 500s (no internal text/stack leaks; logged server-side)
 *   1.4 — per-key token-bucket rate limiting
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { startHttpServer, parseApiKeyRegistryEnv, TokenBucketLimiter } from '../server/http-server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTTP_SERVER_SOURCE = resolve(__dirname, '../server/http-server.ts');

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  if (cleanup) {
    await cleanup();
    cleanup = null;
  }
});

async function setup(
  port: number,
  overrides: Parameters<typeof startHttpServer>[0] = {},
): Promise<string> {
  const instance = await startHttpServer({ port, dbPath: ':memory:', ...overrides });
  cleanup = instance.close;
  return `http://localhost:${port}`;
}

/**
 * A discovered HTTP route: method + a concrete path (regex params substituted
 * with harmless literals).
 */
interface DiscoveredRoute {
  method: string;
  path: string;
}

/**
 * Discovers every route the server dispatches, by scanning the server source.
 * This is deliberately source-derived rather than hand-listed so that any new
 * route a maintainer adds is automatically swept by the tenant-binding test.
 *
 * Handles both dispatch forms in http-server.ts:
 *   - registered-map / if-chain static routes: `path === '/v1/x' && req.method === 'POST'`
 *   - regex routes: `path.match(/^\/v1\/x\/(\d+)$/)` paired with a `req.method` check
 */
function discoverRoutes(): DiscoveredRoute[] {
  const source = readFileSync(HTTP_SERVER_SOURCE, 'utf-8');
  const routes = new Map<string, DiscoveredRoute>();
  const add = (method: string, path: string) => {
    routes.set(`${method} ${path}`, { method, path });
  };

  // Form A: registeredRoutes Map entries — ['POST /v1/x', async (...) => {...}]
  for (const match of source.matchAll(/\['(GET|POST|PUT|DELETE)\s+(\/[^']+)'/g)) {
    add(match[1], match[2]);
  }

  // Form B: static if-chain — path === '/v1/x' && req.method === 'POST'
  for (const match of source.matchAll(
    /path === '(\/[^']+)' && req\.method === '(GET|POST|PUT|DELETE)'/g,
  )) {
    add(match[2], match[1]);
  }

  // Form C: regex routes. Capture the regex literal and the method(s) checked
  // against its match variable within the following ~40 lines.
  const regexRoutePattern =
    /const (\w+) = path\.match\((\/\^.*?\$\/)\);([\s\S]{0,600}?)(?=const \w+ = path\.match|writeError\(res, 404)/g;
  for (const match of source.matchAll(regexRoutePattern)) {
    const varName = match[1];
    const regexLiteral = match[2];
    const following = match[3];
    const concretePath = concretizeRegexPath(regexLiteral);
    if (!concretePath) continue;
    for (const methodMatch of following.matchAll(
      new RegExp(`${varName} && req\\.method === '(GET|POST|PUT|DELETE)'`, 'g'),
    )) {
      add(methodMatch[1], concretePath);
    }
  }

  return [...routes.values()];
}

/**
 * Turns a route regex literal into a concrete path by replacing each capture
 * group with a literal that satisfies it. Returns null if it can't.
 */
function concretizeRegexPath(regexLiteral: string): string | null {
  // Strip the leading `/^` and trailing `$/`.
  let body = regexLiteral.replace(/^\/\^/, '').replace(/\$\/$/, '');
  // Unescape `\/` → `/`.
  body = body.replace(/\\\//g, '/');
  // Replace known capture groups with concrete values. Patterns are built from
  // strings to avoid regex-literal escaping pitfalls with char classes.
  body = body
    .replace(new RegExp('\\(\\\\d\\+\\)', 'g'), '1') // (\d+) numeric id
    .replace(new RegExp('\\(\\[a-z_\\]\\+\\)', 'g'), 'knowledge') // ([a-z_]+) kind
    .replace(new RegExp('\\(accept\\|reject\\|cancel\\)', 'g'), 'accept') // action
    .replace(new RegExp('\\(\\[\\^/\\]\\+\\)', 'g'), 'sess'); // ([^/]+) session/name
  // If any regex metacharacters remain, we failed to concretize.
  if (new RegExp('[()\\[\\]\\\\^$|+*?]').test(body)) return null;
  return body;
}

const TENANT_A = {
  'x-memory-tenant': 'tenant-a',
  'x-memory-system': 'sys',
  'x-memory-scope': 'task',
};
const TENANT_B = {
  'x-memory-tenant': 'tenant-b',
  'x-memory-system': 'sys',
  'x-memory-scope': 'task',
};

// Query params generous enough that param-gated routes reach scope resolution.
const COMMON_QUERY =
  'q=x&timestamp=1&as_of=1&from=1&to=1&since=1970-01-01T00:00:00.000Z';

// Routes exempt from tenant binding (no scope / operational).
const TENANT_EXEMPT = new Set(['GET /healthz', 'GET /readyz']);

describe('1.1 credentials bound to tenants — route-table sweep', () => {
  it('discovers a substantial route surface from the server source', () => {
    const routes = discoverRoutes();
    // Guard against the scanner silently matching nothing.
    expect(routes.length).toBeGreaterThan(40);
  });

  it('a tenant-A key gets 403 on every route when naming tenant B (headers)', async () => {
    const base = await setup(13920, {
      apiKeys: [{ key: 'key-a', tenantId: 'tenant-a' }],
    });
    const routes = discoverRoutes().filter(
      (r) => !TENANT_EXEMPT.has(`${r.method} ${r.path}`),
    );

    const failures: string[] = [];
    for (const route of routes) {
      const url = `${base}${route.path}?${COMMON_QUERY}`;
      const res = await fetch(url, {
        method: route.method,
        headers: {
          Authorization: 'Bearer key-a',
          'Content-Type': 'application/json',
          ...TENANT_B,
        },
        body: route.method === 'GET' || route.method === 'DELETE' ? undefined : '{}',
      });
      // Consume body to free the socket.
      await res.text().catch(() => undefined);
      if (res.status !== 403) {
        failures.push(`${route.method} ${route.path} → ${res.status}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('a tenant-A key gets 403 when naming tenant B via body.scope', async () => {
    const base = await setup(13921, {
      apiKeys: [{ key: 'key-a', tenantId: 'tenant-a' }],
    });
    const res = await fetch(`${base}/v1/facts`, {
      method: 'POST',
      headers: { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fact: 'x',
        factType: 'reference',
        scope: { tenant_id: 'tenant-b', system_id: 'sys', scope_id: 'task' },
      }),
    });
    expect(res.status).toBe(403);
  });

  it('a tenant-A key gets 403 when naming tenant B via query params', async () => {
    const base = await setup(13922, {
      apiKeys: [{ key: 'key-a', tenantId: 'tenant-a' }],
    });
    const res = await fetch(
      `${base}/v1/context?tenant_id=tenant-b&system_id=sys&scope_id=task`,
      { headers: { Authorization: 'Bearer key-a' } },
    );
    expect(res.status).toBe(403);
  });

  it('a tenant-A key succeeds on its own tenant (control)', async () => {
    const base = await setup(13923, {
      apiKeys: [{ key: 'key-a', tenantId: 'tenant-a' }],
    });
    const res = await fetch(`${base}/v1/context`, {
      headers: { Authorization: 'Bearer key-a', ...TENANT_A },
    });
    expect(res.status).toBe(200);
  });

  it('a wildcard key may act on any tenant', async () => {
    const base = await setup(13924, {
      apiKeys: [{ key: 'key-star', tenantId: '*' }],
    });
    const res = await fetch(`${base}/v1/context`, {
      headers: { Authorization: 'Bearer key-star', ...TENANT_B },
    });
    expect(res.status).toBe(200);
  });

  it('an unrecognized key is 401 (not 403)', async () => {
    const base = await setup(13925, {
      apiKeys: [{ key: 'key-a', tenantId: 'tenant-a' }],
    });
    const res = await fetch(`${base}/v1/context`, {
      headers: { Authorization: 'Bearer wrong', ...TENANT_A },
    });
    expect(res.status).toBe(401);
  });
});

describe('1.1 back-compat — legacy single key', () => {
  it('legacy apiKey still authenticates and acts on any tenant', async () => {
    const base = await setup(13926, { apiKey: 'legacy' });
    const ok = await fetch(`${base}/v1/context`, {
      headers: { Authorization: 'Bearer legacy', ...TENANT_B },
    });
    expect(ok.status).toBe(200);
    const bad = await fetch(`${base}/v1/context`, {
      headers: { Authorization: 'Bearer nope' },
    });
    expect(bad.status).toBe(401);
  });

  it('keyless mode leaves all tenants reachable', async () => {
    const base = await setup(13927);
    const res = await fetch(`${base}/v1/context`, { headers: { ...TENANT_B } });
    expect(res.status).toBe(200);
  });

  it('logs a one-time startup warning recommending MEMORY_API_KEYS', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let messages: string[] = [];
    try {
      await setup(13928, { apiKey: 'legacy' });
      // Snapshot before restore: mockRestore() clears recorded calls.
      messages = warn.mock.calls.map((c) => String(c[0]));
    } finally {
      warn.mockRestore();
    }
    expect(messages.some((m) => m.includes('MEMORY_API_KEYS'))).toBe(true);
  });
});

describe('1.1 cross-scope level ceiling', () => {
  it('rejects a scope_level wider than the key ceiling with 403', async () => {
    const base = await setup(13930, {
      apiKeys: [{ key: 'key-a', tenantId: 'tenant-a', maxCrossScopeLevel: 'workspace' }],
    });
    const res = await fetch(
      `${base}/v1/search/cross-scope?q=x&scope_level=tenant`,
      { headers: { Authorization: 'Bearer key-a', ...TENANT_A } },
    );
    expect(res.status).toBe(403);
  });

  it('allows a scope_level at or below the ceiling', async () => {
    const base = await setup(13931, {
      apiKeys: [{ key: 'key-a', tenantId: 'tenant-a', maxCrossScopeLevel: 'workspace' }],
    });
    const res = await fetch(
      `${base}/v1/search/cross-scope?q=x&scope_level=workspace`,
      { headers: { Authorization: 'Bearer key-a', ...TENANT_A } },
    );
    expect(res.status).toBe(200);
  });
});

describe('parseApiKeyRegistryEnv', () => {
  it('parses the documented compact encoding', () => {
    const entries = parseApiKeyRegistryEnv('k1:tenantA:workspace,k2:*,k3:tenantB:tenant:admin');
    expect(entries).toEqual([
      { key: 'k1', tenantId: 'tenantA', maxCrossScopeLevel: 'workspace', admin: false },
      { key: 'k2', tenantId: '*', maxCrossScopeLevel: undefined, admin: false },
      { key: 'k3', tenantId: 'tenantB', maxCrossScopeLevel: 'tenant', admin: true },
    ]);
  });

  it('returns [] for empty/undefined', () => {
    expect(parseApiKeyRegistryEnv(undefined)).toEqual([]);
    expect(parseApiKeyRegistryEnv('   ')).toEqual([]);
  });

  it('throws on a malformed entry', () => {
    expect(() => parseApiKeyRegistryEnv('justakey')).toThrow();
    expect(() => parseApiKeyRegistryEnv('k:t:bogus')).toThrow();
  });
});

describe('1.2 startup posture check', () => {
  it('warns when binding non-loopback with no auth', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let messages: string[] = [];
    try {
      // 0.0.0.0 is non-loopback; no key configured.
      await setup(13940, { host: '0.0.0.0' });
      messages = warn.mock.calls.map((c) => String(c[0]));
    } finally {
      warn.mockRestore();
    }
    expect(messages.some((m) => m.includes('SECURITY') && m.includes('0.0.0.0'))).toBe(true);
  });

  it('does not warn for loopback keyless (dev default)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let messages: string[] = [];
    try {
      await setup(13941, { host: '127.0.0.1' });
      messages = warn.mock.calls.map((c) => String(c[0]));
    } finally {
      warn.mockRestore();
    }
    expect(messages.some((m) => m.includes('SECURITY'))).toBe(false);
  });
});

describe('1.3 sanitized 500s', () => {
  it('never leaks internal error text or stack on a forced internal throw', async () => {
    const secret = 'DRIVER_SECRET_LEAK_TOKEN_XYZ';
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    let base = '';
    try {
      const instance = await startHttpServer({
        port: 13951,
        dbPath: ':memory:',
      });
      cleanup = instance.close;
      base = 'http://localhost:13951';
      // Monkeypatch a manager method to throw a raw internal error.
      const mgr = instance.manager as unknown as { getContext: (...a: unknown[]) => unknown };
      const original = mgr.getContext;
      mgr.getContext = () => {
        throw new Error(`${secret} at Object.<anonymous> (/internal/driver.js:42:7)`);
      };
      const res = await fetch(`${base}/v1/context`);
      const text = await res.text();
      expect(res.status).toBe(500);
      expect(text).not.toContain(secret);
      expect(text).not.toContain('driver.js');
      const body = JSON.parse(text);
      expect(body.error).toBe('internal error');
      expect(typeof body.requestId).toBe('string');
      // Server-side log contains the real error (with the same id).
      const logged = error.mock.calls.flat().map(String).join(' ');
      expect(logged).toContain(secret);
      expect(logged).toContain(body.requestId);
      mgr.getContext = original;
    } finally {
      error.mockRestore();
    }
  });
});

describe('1.2 CORS secure-by-default', () => {
  it('emits NO Access-Control-Allow-Origin by default even with an Origin header', async () => {
    const base = await setup(13970);
    const res = await fetch(`${base}/v1/context`, {
      headers: { Origin: 'https://evil.com' },
    });
    await res.text().catch(() => undefined);
    expect(res.status).toBe(200);
    // Secure default: cross-origin reads are blocked because the browser sees
    // no allow-origin header at all.
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('preflight OPTIONS also emits no allow-origin by default', async () => {
    const base = await setup(13971);
    const res = await fetch(`${base}/v1/context`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.com' },
    });
    await res.text().catch(() => undefined);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('a specific corsOrigin allows only the matching Origin', async () => {
    const base = await setup(13972, { corsOrigin: 'https://app.example.com' });
    const allowed = await fetch(`${base}/v1/context`, {
      headers: { Origin: 'https://app.example.com' },
    });
    await allowed.text().catch(() => undefined);
    expect(allowed.headers.get('access-control-allow-origin')).toBe(
      'https://app.example.com',
    );

    const denied = await fetch(`${base}/v1/context`, {
      headers: { Origin: 'https://evil.com' },
    });
    await denied.text().catch(() => undefined);
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('a comma-separated allowlist echoes any listed origin', async () => {
    const base = await setup(13973, {
      corsOrigin: 'https://a.example.com, https://b.example.com',
    });
    const res = await fetch(`${base}/v1/context`, {
      headers: { Origin: 'https://b.example.com' },
    });
    await res.text().catch(() => undefined);
    expect(res.headers.get('access-control-allow-origin')).toBe(
      'https://b.example.com',
    );
  });

  it("explicit '*' enables the wildcard with a startup warning", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let messages: string[] = [];
    let base = '';
    try {
      base = await setup(13974, { corsOrigin: '*' });
      messages = warn.mock.calls.map((c) => String(c[0]));
    } finally {
      warn.mockRestore();
    }
    const res = await fetch(`${base}/v1/context`, {
      headers: { Origin: 'https://evil.com' },
    });
    await res.text().catch(() => undefined);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(
      messages.some((m) => m.includes('CORS') && m.includes('*')),
    ).toBe(true);
  });
});

describe('1.2 health probes never require auth', () => {
  it('GET /healthz with no Authorization returns 200 even when a key is required', async () => {
    const base = await setup(13975, { apiKey: 'required-key' });
    const res = await fetch(`${base}/healthz`);
    await res.text().catch(() => undefined);
    expect(res.status).toBe(200);
  });

  it('GET /readyz with no Authorization returns 200 even when a key is required', async () => {
    const base = await setup(13976, { apiKey: 'required-key' });
    const res = await fetch(`${base}/readyz`);
    await res.text().catch(() => undefined);
    expect(res.status).toBe(200);
  });

  it('a normal data route still 401s without a key', async () => {
    const base = await setup(13977, { apiKey: 'required-key' });
    const res = await fetch(`${base}/v1/context`);
    await res.text().catch(() => undefined);
    expect(res.status).toBe(401);
  });
});

describe('1.4 rate-limiter bucket eviction (memory DoS guard)', () => {
  it('keeps the bucket map bounded under many distinct keyless source keys', async () => {
    // Small cap so the test is fast; drive many distinct keys through take().
    const limiter = new TokenBucketLimiter(60, 60, 100);
    const now = Date.now();
    for (let i = 0; i < 5000; i++) {
      limiter.take(`ip-${i}`, now);
    }
    // Without eviction this would be 5000; the cap bounds it.
    expect(limiter.size).toBeLessThanOrEqual(100);
  });

  it('idle (fully-refilled) buckets are pruned before oldest-eviction', async () => {
    const limiter = new TokenBucketLimiter(60, 5, 3);
    const t0 = 1_000_000;
    // Fill three buckets, spending a token from each so none is "full" yet.
    limiter.take('a', t0);
    limiter.take('b', t0);
    limiter.take('c', t0);
    expect(limiter.size).toBe(3);
    // Long after t0, all three have refilled to burst (idle). A 4th key triggers
    // eviction, which should prune the idle ones rather than grow unbounded.
    const later = t0 + 60_000;
    limiter.take('d', later);
    expect(limiter.size).toBeLessThanOrEqual(3);
  });
});

describe('1.x SSE error path is sanitized', () => {
  it('a mid-stream throw yields a generic error event, real error logged server-side', async () => {
    const secret = 'STREAM_DRIVER_SECRET_LEAK_ABC';
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const instance = await startHttpServer({ port: 13980, dbPath: ':memory:' });
      cleanup = instance.close;
      const base = 'http://localhost:13980';
      // Force streamChanges to throw after the stream has already opened (200).
      const mgr = instance.manager as unknown as {
        streamChanges: (...a: unknown[]) => AsyncIterable<unknown>;
        resolveChangeStreamCursor: (...a: unknown[]) => Promise<unknown>;
      };
      mgr.resolveChangeStreamCursor = async () => null;
      mgr.streamChanges = () =>
        (async function* () {
          throw new Error(`${secret} at /internal/driver.js:99:1`);
          // eslint-disable-next-line no-unreachable
          yield undefined;
        })();

      const res = await fetch(`${base}/v1/changes/stream`);
      const text = await res.text();
      // Client sees no driver/internal text.
      expect(text).not.toContain(secret);
      expect(text).not.toContain('driver.js');
      // A generic error event with a request id was emitted.
      expect(text).toContain('event: error');
      expect(text).toContain('internal error');
      const idMatch = text.match(/"requestId":"([0-9a-f]+)"/);
      expect(idMatch).not.toBeNull();
      // Server log has the real error under that id.
      const logged = error.mock.calls.flat().map(String).join(' ');
      expect(logged).toContain(secret);
      if (idMatch) expect(logged).toContain(idMatch[1]);
    } finally {
      error.mockRestore();
    }
  });
});

describe('1.x 404 body does not reflect the request path', () => {
  it('omits the attacker-controlled path segment', async () => {
    const base = await setup(13985);
    const marker = 'ATTACKER_MARKER_9f3';
    const res = await fetch(`${base}/v1/${marker}/nonexistent`);
    const text = await res.text();
    expect(res.status).toBe(404);
    expect(text).not.toContain(marker);
  });
});

describe('1.4 rate limiting', () => {
  it('N requests pass, the N+1th is 429 with Retry-After', async () => {
    const limit = 3;
    const base = await setup(13960, { requestsPerMinute: limit, burst: limit });
    const statuses: number[] = [];
    let retryAfter: string | null = null;
    for (let i = 0; i < limit + 1; i++) {
      const res = await fetch(`${base}/v1/context`);
      statuses.push(res.status);
      if (res.status === 429) retryAfter = res.headers.get('retry-after');
      await res.text().catch(() => undefined);
    }
    expect(statuses.slice(0, limit).every((s) => s === 200)).toBe(true);
    expect(statuses[limit]).toBe(429);
    expect(retryAfter).toBeTruthy();
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
  });

  it('never rate-limits /healthz', async () => {
    const base = await setup(13961, { requestsPerMinute: 1, burst: 1 });
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${base}/healthz`);
      expect(res.status).toBe(200);
      await res.text().catch(() => undefined);
    }
  });

  it('separate keys have separate buckets', async () => {
    const base = await setup(13962, {
      requestsPerMinute: 1,
      burst: 1,
      apiKeys: [
        { key: 'ka', tenantId: '*' },
        { key: 'kb', tenantId: '*' },
      ],
    });
    const first = await fetch(`${base}/v1/context`, {
      headers: { Authorization: 'Bearer ka' },
    });
    expect(first.status).toBe(200);
    await first.text().catch(() => undefined);
    // ka is now exhausted.
    const kaSecond = await fetch(`${base}/v1/context`, {
      headers: { Authorization: 'Bearer ka' },
    });
    expect(kaSecond.status).toBe(429);
    await kaSecond.text().catch(() => undefined);
    // kb has its own bucket and still passes.
    const kbFirst = await fetch(`${base}/v1/context`, {
      headers: { Authorization: 'Bearer kb' },
    });
    expect(kbFirst.status).toBe(200);
    await kbFirst.text().catch(() => undefined);
  });
});
