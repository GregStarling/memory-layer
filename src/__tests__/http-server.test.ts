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

  async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
    const startedAt = Date.now();
    while (!predicate()) {
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error('Timed out waiting for condition');
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async function openEventStream(url: string) {
    const controller = new AbortController();
    const response = await fetch(url, {
      headers: { Accept: 'text/event-stream' },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.body).toBeTruthy();

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const events: Array<Record<string, unknown>> = [];
    let buffer = '';
    let connectedResolve: (() => void) | null = null;
    const connected = new Promise<void>((resolve) => {
      connectedResolve = resolve;
    });

    const finished = (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.indexOf('\n\n');
          while (boundary !== -1) {
            const chunk = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf('\n\n');

            const data = chunk
              .split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trim())
              .join('\n');
            if (!data) continue;

            const event = JSON.parse(data) as Record<string, unknown>;
            if (event.type === 'connected') {
              connectedResolve?.();
              connectedResolve = null;
              continue;
            }
            events.push(event);
          }
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          throw error;
        }
      }
    })();

    await connected;

    return {
      events,
      close: async () => {
        controller.abort();
        await finished;
      },
    };
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

  it('returns 404 when revising a playbook from the wrong scope', async () => {
    const base = await setup(13113);

    const created = await fetch(`${base}/v1/playbooks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-memory-tenant': 'acme',
        'x-memory-system': 'assistant',
        'x-memory-workspace': 'shared',
        'x-memory-scope': 'thread-a',
      },
      body: JSON.stringify({
        title: 'Deploy',
        description: 'How to deploy',
        instructions: 'Run deploy.sh',
      }),
    }).then((res) => res.json());

    const reviseRes = await fetch(`${base}/v1/playbooks/${created.playbook.id}/revise`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-memory-tenant': 'acme',
        'x-memory-system': 'assistant',
        'x-memory-workspace': 'shared',
        'x-memory-scope': 'thread-b',
      },
      body: JSON.stringify({
        instructions: 'Run deploy.sh && verify',
        revisionReason: 'Add verification',
      }),
    });

    expect(reviseRes.status).toBe(404);
    await expect(reviseRes.json()).resolves.toMatchObject({
      error: expect.stringContaining('does not belong'),
    });
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

  it('maps typed manager not-found errors without regex matching', async () => {
    const base = await setup(13114);
    const res = await fetch(`${base}/v1/reverification/999`, { method: 'POST' });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain('was not found');
  });

  it('returns health report', async () => {
    const base = await setup(13104);
    const res = await fetch(`${base}/v1/health`);
    expect(res.status).toBe(200);
    const health = await res.json();
    expect(health.activeTurnCount).toBe(0);
    expect(health.tokenEstimate).toBeDefined();
    expect(health.circuitBreakers.embeddings.state).toBeDefined();
  });

  it('exposes session-state and retrieval debug inspectors', async () => {
    const base = await setup(13113);

    await fetch(`${base}/v1/exchanges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userContent: 'Assume staging is current and decide rollback ownership.',
        assistantContent: 'Tool deploy-bot output: rollback rehearsal passed.',
      }),
    });
    await fetch(`${base}/v1/work`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Wait for change approval',
        kind: 'unresolved_work',
        status: 'blocked',
      }),
    });

    const context = await fetch(`${base}/v1/context?query=rollback&debug=true`).then((res) =>
      res.json(),
    );
    expect(context.sessionState.blockers).toContain('Wait for change approval');
    expect(context.debugTrace).toBeTruthy();

    const sessionState = await fetch(`${base}/v1/inspect/session-state?query=rollback`).then((res) =>
      res.json(),
    );
    expect(sessionState.sessionState.blockers).toContain('Wait for change approval');

    const retrieval = await fetch(`${base}/v1/inspect/retrieval?query=rollback`).then((res) =>
      res.json(),
    );
    expect(Array.isArray(retrieval.knowledgeSelectionReasons)).toBe(true);
    expect(retrieval.debugTrace.scope.scopeSource).toBe('local');
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

  it('keeps default-scope SSE subscriptions isolated and accepts capability filters', async () => {
    const instance = await startHttpServer({
      port: 13114,
      dbPath: ':memory:',
      scope: 'default',
    });
    cleanup = instance.close;

    const stream = await openEventStream(
      'http://localhost:13114/v1/events?event_types=knowledge_change,capability',
    );

    try {
      await fetch('http://localhost:13114/v1/facts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fact: 'Default scope fact',
          factType: 'reference',
        }),
      });
      await fetch('http://localhost:13114/v1/facts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-memory-tenant': 'acme',
          'x-memory-system': 'assistant',
          'x-memory-scope': 'other-scope',
        },
        body: JSON.stringify({
          fact: 'Foreign scope fact',
          factType: 'reference',
        }),
      });

      await waitFor(() => stream.events.length >= 1);
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(stream.events).toHaveLength(1);
      expect(stream.events[0]?.type).toBe('knowledge_change');
      expect((stream.events[0]?.scope as { scope_id?: string }).scope_id).toBe('default');
    } finally {
      await stream.close();
    }
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
    expect(res.status).toBe(413);
  });

  it('keeps cached HTTP snapshots stable after live state is touched', async () => {
    const base = await setup(13115);

    await fetch(`${base}/v1/facts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fact: 'Rollback checklist lives in docs/runbooks/rollback.md',
        factType: 'reference',
      }),
    });

    const captured = await fetch(`${base}/v1/sessions/review-session/snapshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relevanceQuery: 'rollback' }),
    }).then((res) => res.json());
    const capturedAccessCount = captured.snapshot.context.relevantKnowledge[0].access_count;

    await fetch(`${base}/v1/context?query=rollback`);

    const fetched = await fetch(`${base}/v1/sessions/review-session/snapshot`).then((res) => res.json());
    expect(fetched.snapshot.context.relevantKnowledge[0].access_count).toBe(capturedAccessCount);
  });

  it('enforces a per-scope snapshot cache bound', async () => {
    const base = await setup(13116);

    for (let index = 0; index < 11; index += 1) {
      const res = await fetch(`${base}/v1/sessions/session-${index}/snapshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relevanceQuery: `session-${index}` }),
      });
      expect(res.status).toBe(201);
    }

    const evicted = await fetch(`${base}/v1/sessions/session-0/snapshot`);
    expect(evicted.status).toBe(404);

    const retained = await fetch(`${base}/v1/sessions/session-10/snapshot`);
    expect(retained.status).toBe(200);
  }, 15000);

  it('GET /v1/episodes requires query param', async () => {
    const base = await setup(13120);
    const res = await fetch(`${base}/v1/episodes`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('q');
  });

  it('GET /v1/episodes returns error without structuredClient', async () => {
    const base = await setup(13121);
    // Seed data so there are turns to find
    await fetch(`${base}/v1/exchanges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userContent: 'Deploy the API',
        assistantContent: 'Deployed successfully.',
      }),
    });
    const res = await fetch(`${base}/v1/episodes?q=deploy`);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toContain('structuredClient');
  });

  it('POST /v1/episodes/summarize returns error without structuredClient', async () => {
    const base = await setup(13122);
    const res = await fetch(`${base}/v1/episodes/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'sess-1' }),
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toContain('structuredClient');
  });

  it('POST /v1/reflect returns error without structuredClient', async () => {
    const base = await setup(13123);
    // Seed data so episodic path is triggered
    await fetch(`${base}/v1/exchanges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userContent: 'Test reflection',
        assistantContent: 'Reflected.',
      }),
    });
    const res = await fetch(`${base}/v1/reflect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'test' }),
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toContain('structuredClient');
  });

  it('GET /v1/memory requires query param', async () => {
    const base = await setup(13124);
    const res = await fetch(`${base}/v1/memory`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('q');
  });

  it('GET /v1/memory returns cognitive search results', async () => {
    const base = await setup(13125);
    // Learn a fact so there's something to find
    await fetch(`${base}/v1/facts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fact: 'User prefers dark mode',
        factType: 'preference',
      }),
    });
    const res = await fetch(`${base}/v1/memory?q=dark+mode`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.byType).toBeDefined();
    expect(body.all).toBeDefined();
    expect(body.all.length).toBeGreaterThan(0);
    expect(body.all[0].item.type).toBe('semantic');
  });

  it('GET /v1/memory supports types filter', async () => {
    const base = await setup(13126);
    await fetch(`${base}/v1/facts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fact: 'Always run tests before merging',
        factType: 'constraint',
      }),
    });
    // Only search procedural — should not find a constraint fact
    const res = await fetch(`${base}/v1/memory?q=tests&types=procedural`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.byType.procedural).toBeDefined();
    // The constraint fact maps to semantic, not procedural
    expect(body.byType.procedural.length).toBe(0);
  });

  it('GET /v1/episodes supports timeRange params', async () => {
    const base = await setup(13127);
    // Just verify the params are accepted (will error on structuredClient)
    const res = await fetch(`${base}/v1/episodes?q=test&start_at=0&end_at=999999999`);
    // Should be 503 (structuredClient unavailable) not 400 (bad params)
    expect(res.status).toBe(503);
  });

  it('rejects malformed request validation inputs with 400s', async () => {
    const base = await setup(13113);

    const badTurn = await fetch(`${base}/v1/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'invalid', content: 'hello' }),
    });
    expect(badTurn.status).toBe(400);

    const badLimit = await fetch(`${base}/v1/search?q=test&limit=abc`);
    expect(badLimit.status).toBe(400);

    const partialScope = await fetch(`${base}/v1/search?q=test&tenant_id=acme&system_id=assistant`);
    expect(partialScope.status).toBe(400);

    const badScopeLevel = await fetch(`${base}/v1/search/cross-scope?q=test&scope_level=planet`);
    expect(badScopeLevel.status).toBe(400);
  });
});
