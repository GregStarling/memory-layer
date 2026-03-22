import { describe, it, expect, afterEach } from 'vitest';
import { startHttpServer } from '../server/http-server.js';

describe('HTTP server', () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  async function setup(port: number) {
    const instance = await startHttpServer({ port, dbPath: ':memory:' });
    cleanup = instance.close;
    return `http://localhost:${port}`;
  }

  it('stores and retrieves turns', async () => {
    const base = await setup(13101);

    // Store exchange
    const storeRes = await fetch(`${base}/v1/exchanges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userContent: 'Remember: always use TypeScript',
        assistantContent: 'Got it, TypeScript only.',
      }),
    });
    expect(storeRes.status).toBe(201);
    const stored = await storeRes.json();
    expect(stored.userTurnId).toBeDefined();

    // Get context
    const contextRes = await fetch(`${base}/v1/context?query=TypeScript`);
    expect(contextRes.status).toBe(200);
    const context = await contextRes.json();
    expect(context.activeTurnCount).toBeGreaterThan(0);
  });

  it('learns facts and searches', async () => {
    const base = await setup(13102);

    await fetch(`${base}/v1/facts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fact: 'User prefers vim keybindings',
        factType: 'preference',
      }),
    });

    const searchRes = await fetch(`${base}/v1/search?q=vim`);
    expect(searchRes.status).toBe(200);
    const results = await searchRes.json();
    expect(results.knowledge.length).toBeGreaterThan(0);
  });

  it('supports hosted cross-scope search and change polling', async () => {
    const base = await setup(13110);

    const since = new Date().toISOString();
    await fetch(`${base}/v1/facts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-memory-tenant': 'acme',
        'x-memory-system': 'assistant',
        'x-memory-workspace': 'shared',
        'x-memory-scope': 'thread-a',
      },
      body: JSON.stringify({
        fact: 'Shared deployment memory',
        factType: 'reference',
      }),
    });

    const crossScope = await fetch(
      `${base}/v1/search/cross-scope?q=shared%20deployment&scope_level=workspace&tenant_id=acme&system_id=assistant&workspace_id=shared&scope_id=thread-b`,
    ).then((res) => res.json());
    expect(crossScope.knowledge[0].fact).toContain('Shared deployment memory');

    const changes = await fetch(
      `${base}/v1/changes?since=${encodeURIComponent(
        since,
      )}&scope_level=workspace&tenant_id=acme&system_id=assistant&workspace_id=shared&scope_id=thread-b`,
    ).then((res) => res.json());
    expect(changes.changes[0].fact).toContain('Shared deployment memory');
  });

  it('shares hosted workspace memory across systems inside a collaboration', async () => {
    const base = await setup(13111);

    await fetch(`${base}/v1/facts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-memory-tenant': 'acme',
        'x-memory-system': 'planner',
        'x-memory-workspace': 'factory',
        'x-memory-collaboration': 'incident-123',
        'x-memory-scope': 'run-a',
      },
      body: JSON.stringify({
        fact: 'Deployment rollback requires cache flush',
        factType: 'reference',
      }),
    });

    const crossScope = await fetch(
      `${base}/v1/search/cross-scope?q=cache%20flush&scope_level=workspace&tenant_id=acme&system_id=executor&workspace_id=factory&collaboration_id=incident-123&scope_id=run-b`,
    ).then((res) => res.json());

    expect(crossScope.knowledge[0].fact).toContain('cache flush');
  });

  it('exposes inspection endpoints and reverification controls', async () => {
    const base = await setup(13112);

    const learned = await fetch(`${base}/v1/facts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fact: 'Primary deployment checklist lives in docs/runbooks/deploy.md',
        factType: 'reference',
      }),
    }).then((res) => res.json());

    const knowledgeList = await fetch(`${base}/v1/inspect/knowledge?limit=10`).then((res) => res.json());
    expect(knowledgeList.items[0].id).toBe(learned.knowledgeId);

    const knowledgeDetail = await fetch(
      `${base}/v1/inspect/knowledge/${learned.knowledgeId}`,
    ).then((res) => res.json());
    expect(knowledgeDetail.knowledge.fact).toContain('deploy.md');
    expect(Array.isArray(knowledgeDetail.evidence)).toBe(true);
    expect(Array.isArray(knowledgeDetail.audits)).toBe(true);

    const audits = await fetch(
      `${base}/v1/inspect/audits?knowledge_id=${learned.knowledgeId}&limit=5`,
    ).then((res) => res.json());
    expect(Array.isArray(audits.audits)).toBe(true);

    const monitor = await fetch(`${base}/v1/inspect/monitor`).then((res) => res.json());
    expect(Object.hasOwn(monitor, 'monitor')).toBe(true);

    const due = await fetch(`${base}/v1/inspect/reverification?limit=5`).then((res) => res.json());
    expect(Array.isArray(due.due)).toBe(true);

    const run = await fetch(`${base}/v1/reverification/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 5 }),
    }).then((res) => res.json());
    expect(Array.isArray(run.reverifiedKnowledgeIds)).toBe(true);
    expect(Array.isArray(run.demotedKnowledgeIds)).toBe(true);
  });

  it('returns 404 for unknown routes', async () => {
    const base = await setup(13103);
    const res = await fetch(`${base}/v1/nonexistent`);
    expect(res.status).toBe(404);
  });

  it('returns health report', async () => {
    const base = await setup(13104);
    const res = await fetch(`${base}/v1/health`);
    expect(res.status).toBe(200);
    const health = await res.json();
    expect(health.activeTurnCount).toBe(0);
    expect(health.tokenEstimate).toBeDefined();
  });

  it('supports multi-scope requests in one process', async () => {
    const base = await setup(13106);

    await fetch(`${base}/v1/facts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-memory-tenant': 'acme',
        'x-memory-system': 'assistant',
        'x-memory-scope': 'thread-a',
      },
      body: JSON.stringify({
        fact: 'Scope A fact',
        factType: 'reference',
      }),
    });

    await fetch(`${base}/v1/facts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-memory-tenant': 'acme',
        'x-memory-system': 'assistant',
        'x-memory-scope': 'thread-b',
      },
      body: JSON.stringify({
        fact: 'Scope B fact',
        factType: 'reference',
      }),
    });

    const scopeA = await fetch(
      `${base}/v1/search?q=fact&tenant_id=acme&system_id=assistant&scope_id=thread-a`,
    ).then((res) => res.json());
    const scopeB = await fetch(
      `${base}/v1/search?q=fact&tenant_id=acme&system_id=assistant&scope_id=thread-b`,
    ).then((res) => res.json());

    expect(scopeA.knowledge).toHaveLength(1);
    expect(scopeB.knowledge).toHaveLength(1);
    expect(scopeA.knowledge[0].fact).toContain('Scope A');
    expect(scopeB.knowledge[0].fact).toContain('Scope B');
  });

  it('responds on health probes', async () => {
    const base = await setup(13107);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
  });

  it('enforces bearer auth when apiKey is set', async () => {
    const instance = await startHttpServer({
      port: 13105,
      dbPath: ':memory:',
      apiKey: 'test-key-123',
    });
    cleanup = instance.close;

    // No auth
    const noAuth = await fetch('http://localhost:13105/v1/health');
    expect(noAuth.status).toBe(401);

    // Wrong auth
    const wrongAuth = await fetch('http://localhost:13105/v1/health', {
      headers: { Authorization: 'Bearer wrong-key' },
    });
    expect(wrongAuth.status).toBe(401);

    // Correct auth
    const goodAuth = await fetch('http://localhost:13105/v1/health', {
      headers: { Authorization: 'Bearer test-key-123' },
    });
    expect(goodAuth.status).toBe(200);
  });

  it('separates admin endpoints with a distinct key', async () => {
    const instance = await startHttpServer({
      port: 13108,
      dbPath: ':memory:',
      adminApiKey: 'admin-key-123',
    });
    cleanup = instance.close;

    const denied = await fetch('http://localhost:13108/v1/maintenance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(denied.status).toBe(403);

    const allowed = await fetch('http://localhost:13108/v1/maintenance', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-key': 'admin-key-123',
      },
      body: '{}',
    });
    expect(allowed.status).toBe(200);
  });

  it('rejects oversized request bodies', async () => {
    const instance = await startHttpServer({
      port: 13109,
      dbPath: ':memory:',
      bodyLimitBytes: 32,
    });
    cleanup = instance.close;

    const res = await fetch('http://localhost:13109/v1/turns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role: 'user',
        content: 'x'.repeat(512),
      }),
    });
    expect(res.status).toBe(500);
  });
});
