/**
 * OpenAPI schema-driven contract validation.
 *
 * Parses `openapi.yaml` at test time and checks that HTTP endpoint responses
 * structurally match their declared response schemas. This is the
 * enforcement layer the review flagged as missing — the transport parity
 * tests pin shape by example, but this test pins shape by *spec*. If the
 * server stops matching what `openapi.yaml` declares, this test fails.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { startHttpServer } from '../server/http-server.js';
import { createInMemoryAdapter } from '../adapters/memory/index.js';
import { wrapSyncAdapter } from '../adapters/sync-to-async.js';
import {
  assertMatchesOpenApi,
  loadOpenApi,
  parseYaml,
} from './helpers/openapi-validator.js';

/**
 * Collapse a path template's parameters (`{id}`, `{playbookId}`, a route
 * regex's `(\d+)`) to a single `{}` placeholder so a spec path and its
 * implementing route compare equal regardless of the param's name.
 */
function normalizePathParams(p: string): string {
  return p.replace(/\{[^}]+\}/g, '{}');
}

/**
 * Enumerate every HTTP route the server actually serves by parsing
 * `http-server.ts`. The server uses two dispatch styles — a `registeredRoutes`
 * Map keyed by `'METHOD /path'`, and an if/regex chain — so we scan for all
 * three forms and normalize path params to `{}`. Returns the set of concrete
 * path templates (method-agnostic; the parity test is about path coverage).
 */
function discoverRoutePaths(): Set<string> {
  const source = readFileSync(
    fileURLToPath(new URL('../server/http-server.ts', import.meta.url)),
    'utf8',
  );
  const paths = new Set<string>();

  // Form A: registeredRoutes Map entries — ['GET /v1/x', async (...) => {...}]
  for (const m of source.matchAll(/\[\s*'(?:GET|POST|PUT|DELETE|PATCH) (\/[^']+)'/g)) {
    paths.add(normalizePathParams(m[1]));
  }
  // Form B: static if-chain — path === '/v1/x'
  for (const m of source.matchAll(/path === '(\/[^']+)'/g)) {
    paths.add(normalizePathParams(m[1]));
  }
  // Form C: regex routes — path.match(/^\/v1\/...$/). Convert each regex to one
  // or more path templates: literal alternations like (accept|reject|cancel)
  // expand into a branch per alternative (they are distinct spec paths); any
  // other capture group (\d+, [^/]+, [a-z_]+) becomes a `{}` param.
  for (const m of source.matchAll(/path\.match\(\/\^(.+?)\$\//g)) {
    let body = m[1];
    const alternations: string[][] = [];
    body = body.replace(/\(([a-z_]+(?:\|[a-z_]+)+)\)/g, (_full, group: string) => {
      alternations.push(group.split('|'));
      return ` A${alternations.length - 1} `;
    });
    body = body.replace(/\([^)]*\)/g, '{}');
    body = body.replace(/\\\//g, '/');
    let combos = [body];
    alternations.forEach((branches, i) => {
      const next: string[] = [];
      for (const c of combos) for (const b of branches) next.push(c.replace(` A${i} `, b));
      combos = next;
    });
    for (const c of combos) paths.add(normalizePathParams(c.startsWith('/') ? c : `/${c}`));
  }

  return paths;
}

function specPaths(): Set<string> {
  const doc = loadOpenApi() as { paths?: Record<string, unknown> };
  const out = new Set<string>();
  for (const key of Object.keys(doc.paths ?? {})) out.add(normalizePathParams(key));
  return out;
}

describe('OpenAPI contract validator (self-test)', () => {
  it('parses openapi.yaml without throwing', () => {
    const doc = loadOpenApi();
    expect(doc).toBeTruthy();
    expect((doc as Record<string, unknown>).openapi).toBe('3.1.0');
    expect((doc as Record<string, unknown>).paths).toBeTruthy();
  });

  it('parses small YAML fragments (indent maps, inline arrays, refs)', () => {
    const fragment = `
foo:
  bar: baz
  items:
    - name: first
      value: 1
    - name: second
      value: 2
  tags: [a, b, c]
  schema:
    $ref: '#/components/schemas/Playbook'
`;
    const parsed = parseYaml(fragment) as Record<string, Record<string, unknown>>;
    expect(parsed.foo.bar).toBe('baz');
    expect(Array.isArray(parsed.foo.items)).toBe(true);
    expect((parsed.foo.items as Array<Record<string, unknown>>)[0].name).toBe('first');
    expect((parsed.foo.items as Array<Record<string, unknown>>)[1].value).toBe(2);
    expect(parsed.foo.tags).toEqual(['a', 'b', 'c']);
    expect((parsed.foo.schema as Record<string, unknown>).$ref).toBe('#/components/schemas/Playbook');
  });
});

describe('OpenAPI contract validation — Phase 1-3 endpoints', () => {
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
  ) {
    const instance = await startHttpServer({ port, dbPath: ':memory:', ...overrides });
    cleanup = instance.close;
    return `http://localhost:${port}`;
  }

  function createAsyncOnlyAdapter() {
    const base = wrapSyncAdapter(createInMemoryAdapter());
    return {
      ...base,
      close: base.close,
    };
  }

  it('GET /v1/profile response matches the documented schema', async () => {
    const base = await setup(13801);
    const res = await fetch(`${base}/v1/profile?view=user`);
    expect(res.status).toBe(200);
    const body = await res.json();
    // Throws with a detailed diff on contract drift.
    assertMatchesOpenApi('/v1/profile', 'get', '200', body);
  });

  it('POST /v1/playbooks 201 response matches the documented schema', async () => {
    const base = await setup(13802);
    const res = await fetch(`${base}/v1/playbooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Contract test',
        description: 'Validates the create response shape',
        instructions: '1. assert shape',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    assertMatchesOpenApi('/v1/playbooks', 'post', '201', body);
  });

  it('GET /v1/playbooks 200 response matches the documented schema', async () => {
    const base = await setup(13803);
    // Seed at least one playbook so the list is non-empty.
    await fetch(`${base}/v1/playbooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'List contract test',
        description: 'x',
        instructions: 'y',
      }),
    });
    const res = await fetch(`${base}/v1/playbooks`);
    expect(res.status).toBe(200);
    const body = await res.json();
    assertMatchesOpenApi('/v1/playbooks', 'get', '200', body);
  });

  it('POST /v1/associations 201 response matches the documented schema', async () => {
    const base = await setup(13804);
    // Need two real knowledge entries to form a valid association.
    const factA = await (
      await fetch(`${base}/v1/facts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fact: 'Fact A', factType: 'reference' }),
      })
    ).json();
    const factB = await (
      await fetch(`${base}/v1/facts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fact: 'Fact B', factType: 'reference' }),
      })
    ).json();

    const res = await fetch(`${base}/v1/associations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source_kind: 'knowledge',
        source_id: factA.knowledgeId,
        target_kind: 'knowledge',
        target_id: factB.knowledgeId,
        association_type: 'related_to',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    assertMatchesOpenApi('/v1/associations', 'post', '201', body);
  });

  it('GET /v1/memory 200 response matches the documented schema', async () => {
    const base = await setup(13805);
    const res = await fetch(`${base}/v1/memory?q=anything`);
    expect(res.status).toBe(200);
    const body = await res.json();
    assertMatchesOpenApi('/v1/memory', 'get', '200', body);
  });

  it('GET /v1/context response matches the documented schema with unresolved work', async () => {
    const base = await setup(13806);
    await fetch(`${base}/v1/work`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Document the rollback checklist',
        kind: 'unresolved_work',
        status: 'blocked',
      }),
    });

    const res = await fetch(`${base}/v1/context?query=rollback`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.unresolvedWork).toContain('Document the rollback checklist');
    expect(body.sessionState).toBeTruthy();
    assertMatchesOpenApi('/v1/context', 'get', '200', body);
  });

  it('POST /v1/context/request response matches the documented schema', async () => {
    const base = await setup(13808);
    const res = await fetch(`${base}/v1/context/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reason: 'missing_workspace_context',
        contract: {
          view: 'workspace_shared',
          crossScopeLevel: 'workspace',
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    assertMatchesOpenApi('/v1/context/request', 'post', '200', body);
  });

  it('GET /v1/context/config response matches the documented schema', async () => {
    const base = await setup(13809, { adminApiKey: 'secret-admin' });
    const res = await fetch(`${base}/v1/context/config`, {
      headers: { 'x-admin-key': 'secret-admin' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    assertMatchesOpenApi('/v1/context/config', 'get', '200', body);
  });

  it('GET /v1/changes 200 response matches the documented schema', async () => {
    const base = await setup(13810);
    await fetch(`${base}/v1/facts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fact: 'Contract-safe shared fact',
        factType: 'reference',
      }),
    });

    const res = await fetch(
      `${base}/v1/changes?since=${encodeURIComponent('1970-01-01T00:00:00.000Z')}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    assertMatchesOpenApi('/v1/changes', 'get', '200', body);
  });

  it('GET /v1/discover 200 response matches the documented schema', async () => {
    const base = await setup(13811);
    const res = await fetch(`${base}/v1/discover`);
    expect(res.status).toBe(200);
    const body = await res.json();
    assertMatchesOpenApi('/v1/discover', 'get', '200', body);
  });

  it('GET /v1/report 200 response matches the documented schema', async () => {
    const base = await setup(13812);
    const res = await fetch(`${base}/v1/report`);
    expect(res.status).toBe(200);
    const body = await res.json();
    assertMatchesOpenApi('/v1/report', 'get', '200', body);
  });

  it('GET /v1/discover 501 response matches the documented schema', async () => {
    const base = await setup(13813, {
      asyncAdapter: createAsyncOnlyAdapter(),
    });
    const res = await fetch(`${base}/v1/discover`);
    expect(res.status).toBe(501);
    const body = await res.json();
    assertMatchesOpenApi('/v1/discover', 'get', '501', body);
  });

  it('GET /v1/aliases 200 response matches the documented schema', async () => {
    const base = await setup(13814);
    await fetch(`${base}/v1/aliases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasMap: { TypeScript: ['ts'] } }),
    });
    const res = await fetch(`${base}/v1/aliases`);
    expect(res.status).toBe(200);
    const body = await res.json();
    assertMatchesOpenApi('/v1/aliases', 'get', '200', body);
  });

  it('GET /v1/ontology 200 response matches the documented schema', async () => {
    const base = await setup(13815);
    await fetch(`${base}/v1/ontology`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ontology: {
          entityTypes: [{ name: 'tool', description: 'A dev tool', allowedRelationships: [] }],
          relationshipConstraints: [],
          validationRules: [],
        },
      }),
    });
    const res = await fetch(`${base}/v1/ontology`);
    expect(res.status).toBe(200);
    const body = await res.json();
    assertMatchesOpenApi('/v1/ontology', 'get', '200', body);
  });

  it('POST /v1/bundles/export 200 response matches the documented schema', async () => {
    const base = await setup(13816);
    const res = await fetch(`${base}/v1/bundles/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'contract-export' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    assertMatchesOpenApi('/v1/bundles/export', 'post', '200', body);
  });

  it('POST /v1/refresh-documents 200 response matches the documented schema', async () => {
    const base = await setup(13817);
    const res = await fetch(`${base}/v1/refresh-documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documents: [] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    assertMatchesOpenApi('/v1/refresh-documents', 'post', '200', body);
  });

  // --- Phase 4.5 wiki routes: shapes match the (corrected) spec ---

  it('POST /v1/documents 201 response matches the documented schema', async () => {
    const base = await setup(13818);
    const res = await fetch(`${base}/v1/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'The user prefers TypeScript.', title: 'Prefs' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    assertMatchesOpenApi('/v1/documents', 'post', '201', body);
  });

  it('GET /v1/documents 200 response matches the documented schema', async () => {
    const base = await setup(13819);
    await fetch(`${base}/v1/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'The user prefers Rust.', title: 'Prefs 2' }),
    });
    const res = await fetch(`${base}/v1/documents`);
    expect(res.status).toBe(200);
    const body = await res.json();
    assertMatchesOpenApi('/v1/documents', 'get', '200', body);
  });

  it('GET /v1/documents/{id} 200 response matches the documented schema', async () => {
    const base = await setup(13820);
    const created = await (
      await fetch(`${base}/v1/documents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'The user prefers Go.', title: 'Prefs 3' }),
      })
    ).json();
    const res = await fetch(`${base}/v1/documents/${created.document.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    assertMatchesOpenApi('/v1/documents/{id}', 'get', '200', body);
  });

  it('GET /v1/export/markdown 200 response matches the documented schema', async () => {
    const base = await setup(13821);
    await fetch(`${base}/v1/facts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fact: 'Exportable fact', factType: 'reference' }),
    });
    const res = await fetch(`${base}/v1/export/markdown`);
    expect(res.status).toBe(200);
    const body = await res.json();
    assertMatchesOpenApi('/v1/export/markdown', 'get', '200', body);
  });

  it('POST /v1/promote-response 200 response matches the documented schema', async () => {
    const base = await setup(13822);
    const turn = await (
      await fetch(`${base}/v1/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'assistant', content: 'The user prefers dark mode.' }),
      })
    ).json();
    const res = await fetch(`${base}/v1/promote-response`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId: turn.turnId }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    assertMatchesOpenApi('/v1/promote-response', 'post', '200', body);
  });

  it('POST /v1/lint/knowledge 200 response matches the documented schema', async () => {
    const base = await setup(13823);
    await fetch(`${base}/v1/facts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fact: 'Lintable fact', factType: 'reference' }),
    });
    const res = await fetch(`${base}/v1/lint/knowledge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    assertMatchesOpenApi('/v1/lint/knowledge', 'post', '200', body);
  });

  // --- Newly-documented real routes (were route-only before Phase 4) ---

  it('GET /v1/inspect/context 200 response matches the documented schema', async () => {
    const base = await setup(13824);
    const res = await fetch(`${base}/v1/inspect/context?query=anything`);
    expect(res.status).toBe(200);
    const body = await res.json();
    assertMatchesOpenApi('/v1/inspect/context', 'get', '200', body);
  });

  it('GET /v1/inspect/session-state 200 response matches the documented schema', async () => {
    const base = await setup(13825);
    const res = await fetch(`${base}/v1/inspect/session-state`);
    expect(res.status).toBe(200);
    const body = await res.json();
    assertMatchesOpenApi('/v1/inspect/session-state', 'get', '200', body);
  });

  it('GET /v1/inspect/retrieval 200 response matches the documented schema', async () => {
    const base = await setup(13826);
    const res = await fetch(`${base}/v1/inspect/retrieval?query=anything`);
    expect(res.status).toBe(200);
    const body = await res.json();
    assertMatchesOpenApi('/v1/inspect/retrieval', 'get', '200', body);
  });

  it('POST + GET /v1/sessions/{id}/snapshot responses match the documented schema', async () => {
    const base = await setup(13827);
    const post = await fetch(`${base}/v1/sessions/sess-1/snapshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(post.status).toBe(201);
    assertMatchesOpenApi('/v1/sessions/{id}/snapshot', 'post', '201', await post.json());

    const get = await fetch(`${base}/v1/sessions/sess-1/snapshot`);
    expect(get.status).toBe(200);
    assertMatchesOpenApi('/v1/sessions/{id}/snapshot', 'get', '200', await get.json());
  });

  it('POST /v1/sessions/{id}/refresh 200 response matches the documented schema', async () => {
    const base = await setup(13828);
    await fetch(`${base}/v1/sessions/sess-2/snapshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const res = await fetch(`${base}/v1/sessions/sess-2/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    assertMatchesOpenApi('/v1/sessions/{id}/refresh', 'post', '200', await res.json());
  });
});

describe('OpenAPI path-set parity (spec ⇆ routes)', () => {
  // Paths that are intentionally in the spec but not served through the
  // dispatch chain: the liveness/readiness probes are handled before routing
  // (they must answer without auth), so the route scanner never sees them.
  const SPEC_ONLY_ALLOWLIST = new Set(['/healthz', '/readyz']);
  // Routes intentionally undocumented (none today). Kept explicit so a future
  // deliberate omission is a visible, reviewed decision rather than a silent gap.
  const ROUTE_ONLY_ALLOWLIST = new Set<string>();

  it('every documented spec path is served by a route', () => {
    const routes = discoverRoutePaths();
    const specOnly = [...specPaths()]
      .filter((p) => !routes.has(p) && !SPEC_ONLY_ALLOWLIST.has(p))
      .sort();
    expect(specOnly).toEqual([]);
  });

  it('every served route path is documented in the spec', () => {
    const spec = specPaths();
    const routeOnly = [...discoverRoutePaths()]
      .filter((p) => !spec.has(p) && !ROUTE_ONLY_ALLOWLIST.has(p))
      .sort();
    expect(routeOnly).toEqual([]);
  });

  it('the route scanner finds a substantial surface (guards against matching nothing)', () => {
    expect(discoverRoutePaths().size).toBeGreaterThan(60);
  });

  it('the YAML parser sees every raw path key (guards against silent parser drops)', () => {
    // The hand-rolled YAML parser silently drops paths after constructs it
    // does not support (e.g. `>-` folded scalars) and can drop a path block
    // appended at EOF — either failure mode would let a documented-but-
    // unimplemented path escape BOTH parity directions. Count the raw
    // 2-space-indented `/path:` keys in the file and require the parsed
    // document to contain exactly that many.
    const raw = readFileSync(fileURLToPath(new URL('../../openapi.yaml', import.meta.url)), 'utf8');
    const rawPathKeys = raw.match(/^ {2}\/[^\s:]*:/gm) ?? [];
    const parsed = loadOpenApi() as { paths?: Record<string, unknown> };
    expect(Object.keys(parsed.paths ?? {}).length).toBe(rawPathKeys.length);
  });
});
