import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { startHttpServer } from '../server/http-server.js';
import { createSQLiteAdapter } from '../adapters/sqlite/index.js';
import { createInMemoryAdapter } from '../adapters/memory/index.js';
import { wrapSyncAdapter } from '../adapters/sync-to-async.js';

describe('HTTP server', () => {
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

  it('returns context expansion resolutions over HTTP', async () => {
    const base = await setup(3217);
    const response = await fetch(`${base}/v1/context/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reason: 'need_higher_budget',
        note: 'Need more room for deployment invariants.',
        contract: {
          tokenBudget: 4000,
          view: 'workspace_shared',
          crossScopeLevel: 'workspace',
        },
      }),
    });

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.proposedContract.tokenBudget).toBe(4000);
    expect(payload.proposedContract.view).toBe('workspace_shared');
  });

  it('manages context governance over HTTP and applies escalation policy', async () => {
    const base = await setup(3218, {
      adminApiKey: 'secret-admin',
      contextContracts: {
        executor: {
          tokenBudget: 2000,
          knowledgeClasses: ['constraint'],
        },
      },
    });
    const adminHeaders = {
      'Content-Type': 'application/json',
      'x-admin-key': 'secret-admin',
    };

    const updateConfig = await fetch(`${base}/v1/context/config/escalation-policy`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({
        policy: {
          defaultDecision: 'allow',
          byChange: {
            increase_token_budget: 'deny',
          },
        },
      }),
    });
    expect(updateConfig.status).toBe(200);

    const addInvariant = await fetch(`${base}/v1/context/config/invariants/english-only`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({
        invariant: {
          title: 'Language',
          instruction: 'All responses must be in English.',
          severity: 'important',
        },
      }),
    });
    expect(addInvariant.status).toBe(200);
    const governance = await addInvariant.json();
    expect(governance.invariants[0].id).toBe('english-only');

    const request = await fetch(`${base}/v1/context/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reason: 'need_higher_budget',
        currentContract: 'executor',
        contract: {
          tokenBudget: 4000,
        },
      }),
    });
    expect(request.status).toBe(200);
    const resolution = await request.json();
    expect(resolution.decision).toBe('denied');

    const readConfig = await fetch(`${base}/v1/context/config`, {
      headers: { 'x-admin-key': 'secret-admin' },
    });
    expect(readConfig.status).toBe(200);
    const snapshot = await readConfig.json();
    expect(snapshot.contracts.executor.tokenBudget).toBe(2000);
    expect(snapshot.escalationPolicy.byChange.increase_token_budget).toBe('deny');
  });

  it('deletes named contracts and invariants over HTTP', async () => {
    const base = await setup(3219, { adminApiKey: 'secret-admin' });
    const adminHeaders = {
      'Content-Type': 'application/json',
      'x-admin-key': 'secret-admin',
    };

    // PUT a named contract
    const putContract = await fetch(`${base}/v1/context/config/contracts/executor`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({
        contract: { tokenBudget: 2000, knowledgeClasses: ['constraint'] },
      }),
    });
    expect(putContract.status).toBe(200);

    // PUT an invariant
    const putInvariant = await fetch(`${base}/v1/context/config/invariants/english-only`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({
        invariant: { title: 'Language', instruction: 'English only.', severity: 'important' },
      }),
    });
    expect(putInvariant.status).toBe(200);

    // DELETE the contract
    const deleteContract = await fetch(`${base}/v1/context/config/contracts/executor`, {
      method: 'DELETE',
      headers: { 'x-admin-key': 'secret-admin' },
    });
    expect(deleteContract.status).toBe(200);
    const contractResult = await deleteContract.json();
    expect(contractResult.deleted).toBe(true);

    // DELETE the invariant
    const deleteInvariant = await fetch(`${base}/v1/context/config/invariants/english-only`, {
      method: 'DELETE',
      headers: { 'x-admin-key': 'secret-admin' },
    });
    expect(deleteInvariant.status).toBe(200);
    const invariantResult = await deleteInvariant.json();
    expect(invariantResult.deleted).toBe(true);

    // Confirm they are gone
    const config = await fetch(`${base}/v1/context/config`, {
      headers: { 'x-admin-key': 'secret-admin' },
    });
    const snapshot = await config.json();
    expect(snapshot.contracts).toEqual({});
    expect(snapshot.invariants).toEqual([]);
  });

  it('returns deleted: false for nonexistent governance resources', async () => {
    const base = await setup(3220, { adminApiKey: 'secret-admin' });
    const adminHeaders = { 'x-admin-key': 'secret-admin' };

    const deleteContract = await fetch(`${base}/v1/context/config/contracts/nope`, {
      method: 'DELETE',
      headers: adminHeaders,
    });
    expect(deleteContract.status).toBe(200);
    expect((await deleteContract.json()).deleted).toBe(false);

    const deleteInvariant = await fetch(`${base}/v1/context/config/invariants/nope`, {
      method: 'DELETE',
      headers: adminHeaders,
    });
    expect(deleteInvariant.status).toBe(200);
    expect((await deleteInvariant.json()).deleted).toBe(false);
  });

  it('sets and clears the default context contract over HTTP', async () => {
    const base = await setup(3221, { adminApiKey: 'secret-admin' });
    const adminHeaders = {
      'Content-Type': 'application/json',
      'x-admin-key': 'secret-admin',
    };

    // Set default contract
    const setDefault = await fetch(`${base}/v1/context/config/default-contract`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({ contract: { tokenBudget: 1500, view: 'local_only' } }),
    });
    expect(setDefault.status).toBe(200);

    // Verify it's set
    const config1 = await (await fetch(`${base}/v1/context/config`, { headers: { 'x-admin-key': 'secret-admin' } })).json();
    expect(config1.defaultContract.tokenBudget).toBe(1500);

    // Clear default contract
    const clearDefault = await fetch(`${base}/v1/context/config/default-contract`, {
      method: 'DELETE',
      headers: { 'x-admin-key': 'secret-admin' },
    });
    expect(clearDefault.status).toBe(200);

    // Verify it's cleared
    const config2 = await (await fetch(`${base}/v1/context/config`, { headers: { 'x-admin-key': 'secret-admin' } })).json();
    expect(config2.defaultContract).toBeNull();
  });

  it('rejects governance mutations without admin key', async () => {
    const base = await setup(3222, { adminApiKey: 'secret-admin' });
    const headers = { 'Content-Type': 'application/json' };

    const putContract = await fetch(`${base}/v1/context/config/contracts/executor`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ contract: { tokenBudget: 2000 } }),
    });
    expect(putContract.status).toBe(403);

    const putInvariant = await fetch(`${base}/v1/context/config/invariants/test`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ invariant: { title: 'Test', instruction: 'Test.', severity: 'advisory' } }),
    });
    expect(putInvariant.status).toBe(403);

    const putPolicy = await fetch(`${base}/v1/context/config/escalation-policy`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ policy: { defaultDecision: 'deny' } }),
    });
    expect(putPolicy.status).toBe(403);

    const getConfig = await fetch(`${base}/v1/context/config`);
    expect(getConfig.status).toBe(403);
  });

  it('rejects invalid governance input with 400', async () => {
    const base = await setup(3223, { adminApiKey: 'secret-admin' });
    const adminHeaders = {
      'Content-Type': 'application/json',
      'x-admin-key': 'secret-admin',
    };

    // Malformed contract (view is not a valid enum)
    const badContract = await fetch(`${base}/v1/context/config/contracts/bad`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({ contract: { view: 'not_a_view' } }),
    });
    expect(badContract.status).toBe(400);

    // Malformed invariant (missing required fields)
    const badInvariant = await fetch(`${base}/v1/context/config/invariants/bad`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({ invariant: { title: 'No instruction' } }),
    });
    expect(badInvariant.status).toBe(400);

    // Malformed policy (invalid decision)
    const badPolicy = await fetch(`${base}/v1/context/config/escalation-policy`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({ policy: { defaultDecision: 'yolo' } }),
    });
    expect(badPolicy.status).toBe(400);

    const badPolicyChange = await fetch(`${base}/v1/context/config/escalation-policy`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({ policy: { byChange: { broaden_viwe: 'deny' } } }),
    });
    expect(badPolicyChange.status).toBe(400);
  });

  it('denies expansion when maxTokenBudget ceiling is exceeded', async () => {
    const base = await setup(3224, {
      adminApiKey: 'secret-admin',
      escalationPolicy: {
        defaultDecision: 'allow',
        maxTokenBudget: 3000,
      },
    });

    const request = await fetch(`${base}/v1/context/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reason: 'need_higher_budget',
        contract: { tokenBudget: 5000 },
      }),
    });
    expect(request.status).toBe(200);
    const resolution = await request.json();
    expect(resolution.decision).toBe('denied');
    expect(resolution.rationale).toBeTruthy();
  });

  it('denies expansion when maxView ceiling is exceeded', async () => {
    const base = await setup(3225, {
      adminApiKey: 'secret-admin',
      escalationPolicy: {
        defaultDecision: 'allow',
        maxView: 'local_only',
      },
    });

    const request = await fetch(`${base}/v1/context/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reason: 'missing_workspace_context',
        contract: { view: 'workspace_shared' },
      }),
    });
    expect(request.status).toBe(200);
    const resolution = await request.json();
    expect(resolution.decision).toBe('denied');
  });

  it('propagates governance mutations to session-scoped managers', async () => {
    const base = await setup(3226, { adminApiKey: 'secret-admin' });
    const adminHeaders = {
      'Content-Type': 'application/json',
      'x-admin-key': 'secret-admin',
    };

    // Create a session-scoped manager by capturing a snapshot
    const snapshotRes = await fetch(`${base}/v1/sessions/test-session/snapshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(snapshotRes.status).toBe(201);

    // Now put an invariant at the scope level — should propagate to session manager
    const putInvariant = await fetch(`${base}/v1/context/config/invariants/propagated`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({
        invariant: {
          title: 'Propagation Test',
          instruction: 'This should reach session managers.',
          severity: 'important',
        },
      }),
    });
    expect(putInvariant.status).toBe(200);

    // Verify the session-scoped manager sees the invariant in its context
    const contextRes = await fetch(`${base}/v1/sessions/test-session/snapshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(contextRes.status).toBe(201);
    const payload = await contextRes.json();
    const invariantIds =
      payload.snapshot?.context?.invariants?.map((i: { id: string }) => i.id) ?? [];
    expect(invariantIds).toContain('propagated');
  });

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
        visibility_class: 'workspace',
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
    expect(typeof changes.nextCursor).toBe('string');
  });

  it('returns cursor-based knowledge changes without duplicating the boundary item', async () => {
    const base = await setup(13112);

    const create = await fetch(`${base}/v1/facts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-memory-tenant': 'acme',
        'x-memory-system': 'planner',
        'x-memory-workspace': 'shared',
        'x-memory-scope': 'thread-a',
      },
      body: JSON.stringify({
        fact: 'Cursor-safe shared fact',
        factType: 'reference',
        visibility_class: 'workspace',
      }),
    }).then((res) => res.json());

    const firstPage = await fetch(
      `${base}/v1/changes?since=${encodeURIComponent(
        '1970-01-01T00:00:00.000Z',
      )}&scope_level=workspace&tenant_id=acme&system_id=assistant&workspace_id=shared&scope_id=thread-b`,
    ).then((res) => res.json());
    expect(firstPage.changes.some((change: Record<string, unknown>) => change.fact === 'Cursor-safe shared fact')).toBe(true);
    expect(typeof firstPage.nextCursor).toBe('string');

    const secondPage = await fetch(
      `${base}/v1/changes?cursor=${firstPage.nextCursor}&scope_level=workspace&tenant_id=acme&system_id=assistant&workspace_id=shared&scope_id=thread-b`,
    ).then((res) => res.json());
    expect(secondPage.changes).toEqual([]);

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
        fact: 'Second cursor-safe shared fact',
        factType: 'reference',
        visibility_class: 'workspace',
      }),
    });

    const afterUpdate = await fetch(
      `${base}/v1/changes?cursor=${firstPage.nextCursor}&scope_level=workspace&tenant_id=acme&system_id=assistant&workspace_id=shared&scope_id=thread-b`,
    ).then((res) => res.json());
    expect(afterUpdate.changes.some((change: Record<string, unknown>) => change.fact === 'Second cursor-safe shared fact')).toBe(true);
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
        visibility_class: 'shared_collaboration',
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

  it('returns coordination source event ids and maintenance association deletions in HTTP responses', async () => {
    const base = await setup(13114);
    const actor = {
      actor_kind: 'agent',
      actor_id: 'planner',
      system_id: null,
      display_name: null,
      metadata: null,
    };
    const recipient = {
      actor_kind: 'human',
      actor_id: 'operator',
      system_id: null,
      display_name: 'Op',
      metadata: null,
    };

    const work = await fetch(`${base}/v1/work`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Ship rollout',
      }),
    }).then((res) => res.json());

    const claim = await fetch(`${base}/v1/work-items/${work.workItemId}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor }),
    }).then((res) => res.json());
    const handoff = await fetch(`${base}/v1/work-items/${work.workItemId}/handoffs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from_actor: actor,
        to_actor: recipient,
        summary: 'Take over deploy watch',
      }),
    }).then((res) => res.json());
    const maintenance = await fetch(`${base}/v1/maintenance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }).then((res) => res.json());

    expect(claim.claim.source_event_id).toBeDefined();
    expect(handoff.handoff.source_event_id).toBeDefined();
    expect(Array.isArray(maintenance.deletedAssociationIds)).toBe(true);
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

  it('captures HTTP snapshot watermarks from the latest event cursor', async () => {
    const instance = await startHttpServer({ port: 13117, dbPath: ':memory:' });
    cleanup = instance.close;
    const base = 'http://localhost:13117';

    await fetch(`${base}/v1/exchanges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userContent: 'First event',
        assistantContent: 'Second event',
      }),
    });

    const latestCursor = await instance.manager.resolveChangeStreamCursor();
    const snapshot = await fetch(`${base}/v1/sessions/review-session/snapshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }).then((res) => res.json());

    expect(snapshot.snapshot.watermarkEventId).toBe(latestCursor === '0' ? null : latestCursor);
  });

  // Seeds 5001 turns into an on-disk sqlite file — legitimately slow on shared
  // CI runners, so it carries an explicit timeout instead of the 5s default.
  it('rejects oversized HTTP diff ranges at the default transport cap', { timeout: 30_000 }, async () => {
    const dbPath = `/tmp/memory-layer-http-diff-${Date.now()}-${Math.random()}.sqlite`;
    const instance = await startHttpServer({ port: 13118, dbPath });
    cleanup = async () => {
      await instance.close();
      rmSync(dbPath, { force: true });
    };
    const adapter = createSQLiteAdapter(dbPath);

    for (let index = 0; index < 5001; index += 1) {
      adapter.insertTurn({
        tenant_id: 'default',
        system_id: 'default',
        workspace_id: '',
        collaboration_id: '',
        scope_id: 'default',
        session_id: 'session-1',
        actor: 'user',
        role: 'user',
        content: `turn-${index}`,
      });
    }
    adapter.close();

    const res = await fetch(`http://localhost:13118/v1/state/diff?from=0&to=${Math.floor(Date.now() / 1000) + 1}`);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringMatching(/event range exceeds maximum of 5000/i),
    });
  });

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

  it('supports hosted phase-5 HTTP routes on wrapped-sync SQLite deployments', async () => {
    const base = await setup(13128);

    expect((await fetch(`${base}/v1/discover`)).status).toBe(200);
    expect((await fetch(`${base}/v1/report`)).status).toBe(200);

    const exported = await fetch(`${base}/v1/bundles/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'backup-http' }),
    });
    expect(exported.status).toBe(200);
    const exportedBody = await exported.json();

    const imported = await fetch(`${base}/v1/bundles/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bundle: exportedBody.bundle,
        conflictResolution: 'skip',
      }),
    });
    expect(imported.status).toBe(200);

    const refreshed = await fetch(`${base}/v1/refresh-documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documents: [] }),
    });
    expect(refreshed.status).toBe(200);
  });

  it('returns 501 not_implemented for phase-5 HTTP routes on async-only deployments', async () => {
    const base = await setup(13129, {
      asyncAdapter: createAsyncOnlyAdapter(),
    });

    const discover = await fetch(`${base}/v1/discover`);
    expect(discover.status).toBe(501);
    await expect(discover.json()).resolves.toMatchObject({ code: 'not_implemented' });

    const report = await fetch(`${base}/v1/report`);
    expect(report.status).toBe(501);
    await expect(report.json()).resolves.toMatchObject({ code: 'not_implemented' });

    const exported = await fetch(`${base}/v1/bundles/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'backup-http' }),
    });
    expect(exported.status).toBe(501);
    await expect(exported.json()).resolves.toMatchObject({ code: 'not_implemented' });

    const imported = await fetch(`${base}/v1/bundles/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bundle: { name: 'bundle' },
        conflictResolution: 'skip',
      }),
    });
    expect(imported.status).toBe(501);
    await expect(imported.json()).resolves.toMatchObject({ code: 'not_implemented' });

    const refreshed = await fetch(`${base}/v1/refresh-documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documents: [] }),
    });
    expect(refreshed.status).toBe(501);
    await expect(refreshed.json()).resolves.toMatchObject({ code: 'not_implemented' });
  });

  it('persists aliases and ontology across cache churn and restart', async () => {
    const dbPath = `/tmp/memory-layer-phase5-${Date.now()}-${Math.random()}.sqlite`;
    const first = await startHttpServer({ port: 13130, dbPath, adminApiKey: 'secret-admin' });
    cleanup = async () => {
      await first.close();
      rmSync(dbPath, { force: true });
    };
    const base = 'http://localhost:13130';
    const aliasMap = { TypeScript: ['ts', 'TS'] };
    const ontology = {
      entityTypes: [{ name: 'tool', description: 'A dev tool', allowedRelationships: [] }],
      relationshipConstraints: [],
      validationRules: [],
    };

    expect(
      (
        await fetch(`${base}/v1/aliases`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ aliasMap }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(`${base}/v1/ontology`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ontology }),
        })
      ).status,
    ).toBe(200);

    for (let index = 0; index < 257; index += 1) {
      const res = await fetch(
        `${base}/v1/context/config?tenant_id=default&system_id=default&scope_id=scope-${index}`,
        { headers: { 'x-admin-key': 'secret-admin' } },
      );
      expect(res.status).toBe(200);
    }

    await expect(fetch(`${base}/v1/aliases`).then((res) => res.json())).resolves.toEqual({ aliasMap });
    await expect(fetch(`${base}/v1/ontology`).then((res) => res.json())).resolves.toEqual({ ontology });

    await first.close();
    const second = await startHttpServer({ port: 13131, dbPath, adminApiKey: 'secret-admin' });
    cleanup = async () => {
      await second.close();
      rmSync(dbPath, { force: true });
    };
    const restartedBase = 'http://localhost:13131';

    await expect(fetch(`${restartedBase}/v1/aliases`).then((res) => res.json())).resolves.toEqual({ aliasMap });
    await expect(fetch(`${restartedBase}/v1/ontology`).then((res) => res.json())).resolves.toEqual({ ontology });
  }, 15000);

  it('shares persisted alias updates across implicit and explicit default-scope managers', async () => {
    const adapter = createInMemoryAdapter();
    adapter.insertKnowledgeMemory({
      tenant_id: 'default',
      system_id: 'default',
      scope_id: 'default',
      fact: 'PostgreSQL is the primary database',
      fact_type: 'entity',
      fact_subject: 'entity',
      fact_value: 'PostgreSQL',
      source: 'user_stated',
      confidence: 'high',
    });
    adapter.insertKnowledgeMemory({
      tenant_id: 'default',
      system_id: 'default',
      scope_id: 'default',
      fact: 'PostreSQL credentials rotate monthly',
      fact_type: 'entity',
      fact_subject: 'entity',
      fact_value: 'PostreSQL',
      source: 'user_stated',
      confidence: 'high',
    });

    const base = await setup(13132, {
      asyncAdapter: wrapSyncAdapter(adapter),
    });
    const explicitScopeQuery = 'tenant_id=default&system_id=default&scope_id=default';

    expect((await fetch(`${base}/v1/context`)).status).toBe(200);
    expect((await fetch(`${base}/v1/context?${explicitScopeQuery}`)).status).toBe(200);

    const before = await fetch(`${base}/v1/alias-candidates?${explicitScopeQuery}&min_similarity=0.8`);
    expect(before.status).toBe(200);
    expect((await before.json()).candidates.length).toBeGreaterThan(0);

    const update = await fetch(`${base}/v1/aliases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasMap: { PostgreSQL: ['PostreSQL'] } }),
    });
    expect(update.status).toBe(200);

    const after = await fetch(`${base}/v1/alias-candidates?${explicitScopeQuery}&min_similarity=0.8`);
    expect(after.status).toBe(200);
    expect((await after.json()).candidates).toHaveLength(0);
  });

  it('rejects malformed alias and ontology config writes over HTTP', async () => {
    const base = await setup(13133);

    const badAliases = await fetch(`${base}/v1/aliases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliasMap: { TypeScript: 'ts' } }),
    });
    expect(badAliases.status).toBe(400);
    await expect(badAliases.json()).resolves.toMatchObject({
      code: 'validation_error',
    });

    const badOntology = await fetch(`${base}/v1/ontology`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ontology: {
          entityTypes: [{ name: 'tool', description: 'A dev tool', allowedRelationships: ['bad'] }],
          relationshipConstraints: [],
          validationRules: [],
        },
      }),
    });
    expect(badOntology.status).toBe(400);
    await expect(badOntology.json()).resolves.toMatchObject({
      code: 'validation_error',
    });
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

  it('rejects malformed numeric transport inputs with 400s', async () => {
    const base = await setup(13119);

    const work = await fetch(`${base}/v1/work`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Ship rollout' }),
    }).then((res) => res.json());

    expect((await fetch(`${base}/v1/state?as_of=NaN`)).status).toBe(400);
    expect((await fetch(`${base}/v1/timeline?cursor=abc`)).status).toBe(400);
    expect((await fetch(`${base}/v1/state/diff?from=Infinity&to=1`)).status).toBe(400);
    expect((await fetch(`${base}/v1/episodes?q=test&start_at=NaN`)).status).toBe(400);
    expect((await fetch(`${base}/v1/memory?q=test&minimumTrustScore=Infinity`)).status).toBe(400);
    expect((await fetch(`${base}/v1/profile?min_trust=NaN`)).status).toBe(400);

    expect(
      (
        await fetch(`${base}/v1/work-items/${work.workItemId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expectedVersion: 'NaN' }),
        })
      ).status,
    ).toBe(400);

    expect(
      (
        await fetch(`${base}/v1/work-items/${work.workItemId}/claim`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            actor: { actor_kind: 'agent', actor_id: 'planner' },
            leaseSeconds: 'Infinity',
          }),
        })
      ).status,
    ).toBe(400);

    expect(
      (
        await fetch(`${base}/v1/work-items/${work.workItemId}/handoffs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from_actor: { actor_kind: 'agent', actor_id: 'planner' },
            to_actor: { actor_kind: 'human', actor_id: 'operator' },
            summary: 'Take over',
            expires_at: 'Infinity',
          }),
        })
      ).status,
    ).toBe(400);

    expect(
      (
        await fetch(`${base}/v1/reflect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: 'deploy',
            timeRange: { start_at: 'bad' },
          }),
        })
      ).status,
    ).toBe(400);

    expect(
      (
        await fetch(`${base}/v1/playbooks/from-task`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: 'Deploy',
            description: 'Ship it',
            sessionId: 'session-1',
            sourceWorkingMemoryId: 'bad',
          }),
        })
      ).status,
    ).toBe(400);
  });

  // Phase 4.5: the five wiki routes that were documented in openapi.yaml but
  // had no implementation (generated clients 404'd). Each is a thin dispatch to
  // an existing manager method through the standard auth + scope pipeline.
  describe('wiki surface routes (documents / export / promote / lint)', () => {
    // A GET and a POST variant per route so the auth + scope loops cover both.
    const NEW_ROUTES: Array<{ method: 'GET' | 'POST'; path: string; body?: unknown }> = [
      { method: 'POST', path: '/v1/documents', body: { content: 'x', title: 'T' } },
      { method: 'GET', path: '/v1/documents' },
      { method: 'GET', path: '/v1/documents/1' },
      { method: 'GET', path: '/v1/export/markdown' },
      { method: 'POST', path: '/v1/promote-response', body: { turnId: 1 } },
      { method: 'POST', path: '/v1/lint/knowledge', body: {} },
    ];

    it('POST /v1/documents ingests a document and returns {document, knowledge}', async () => {
      const base = await setup(13130);
      const res = await fetch(`${base}/v1/documents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'The user prefers TypeScript.', title: 'Preferences' }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.document).toBeTruthy();
      expect(body.document.title).toBe('Preferences');
      expect(body.document.status).toBe('processed');
      expect(Array.isArray(body.knowledge)).toBe(true);
    });

    it('POST /v1/documents rejects a missing required field with 400', async () => {
      const base = await setup(13131);
      const res = await fetch(`${base}/v1/documents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'no content' }),
      });
      expect(res.status).toBe(400);
    });

    it('GET /v1/documents lists ingested documents with pagination fields', async () => {
      const base = await setup(13132);
      await fetch(`${base}/v1/documents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'The user prefers Rust.', title: 'Doc A' }),
      });
      const res = await fetch(`${base}/v1/documents`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.items)).toBe(true);
      expect(body.items.length).toBeGreaterThanOrEqual(1);
      expect(typeof body.hasMore).toBe('boolean');
      expect('nextCursor' in body).toBe(true);
    });

    it('GET /v1/documents/:id returns the document, and 404 for an unknown id', async () => {
      const base = await setup(13133);
      const created = await (
        await fetch(`${base}/v1/documents`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: 'The user prefers Go.', title: 'Doc B' }),
        })
      ).json();
      const ok = await fetch(`${base}/v1/documents/${created.document.id}`);
      expect(ok.status).toBe(200);
      expect((await ok.json()).id).toBe(created.document.id);

      const missing = await fetch(`${base}/v1/documents/999999`);
      expect(missing.status).toBe(404);
    });

    it('GET /v1/export/markdown returns files (as an object) and stats', async () => {
      const base = await setup(13134);
      await fetch(`${base}/v1/facts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fact: 'Exportable fact', factType: 'reference' }),
      });
      const res = await fetch(`${base}/v1/export/markdown?includeTrustMetadata=true`);
      expect(res.status).toBe(200);
      const body = await res.json();
      // files must be a plain JSON object (the manager returns a Map).
      expect(body.files && typeof body.files === 'object' && !Array.isArray(body.files)).toBe(true);
      expect(typeof body.stats.totalFacts).toBe('number');
      expect(typeof body.stats.totalFiles).toBe('number');
    });

    it('GET /v1/export/markdown rejects an invalid groupBy with 400', async () => {
      const base = await setup(13135);
      const res = await fetch(`${base}/v1/export/markdown?groupBy=bogus`);
      expect(res.status).toBe(400);
    });

    it('POST /v1/promote-response promotes knowledge from an assistant turn', async () => {
      const base = await setup(13136);
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
      expect(Array.isArray((await res.json()).knowledge)).toBe(true);
    });

    it('POST /v1/promote-response 404s for an unknown turn and 400s for a bad turnId', async () => {
      const base = await setup(13137);
      const missing = await fetch(`${base}/v1/promote-response`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ turnId: 987654 }),
      });
      expect(missing.status).toBe(404);

      const bad = await fetch(`${base}/v1/promote-response`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ turnId: 'not-a-number' }),
      });
      expect(bad.status).toBe(400);
    });

    it('POST /v1/lint/knowledge returns a lint report', async () => {
      const base = await setup(13138);
      await fetch(`${base}/v1/facts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fact: 'Lintable fact', factType: 'reference' }),
      });
      const res = await fetch(`${base}/v1/lint/knowledge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ categories: ['trust_distribution'] }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.issues)).toBe(true);
      expect(typeof body.stats.totalKnowledge).toBe('number');
      expect(typeof body.generatedAt).toBe('number');
    });

    it('POST /v1/lint/knowledge rejects an invalid category with 400', async () => {
      const base = await setup(13139);
      const res = await fetch(`${base}/v1/lint/knowledge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ categories: ['not_a_category'] }),
      });
      expect(res.status).toBe(400);
    });

    it('requires bearer auth on every wiki route when apiKey is set', async () => {
      const base = await setup(13140, { apiKey: 'wiki-key' });
      for (const route of NEW_ROUTES) {
        const res = await fetch(`${base}${route.path}`, {
          method: route.method,
          headers: { 'Content-Type': 'application/json' },
          body: route.body ? JSON.stringify(route.body) : undefined,
        });
        await res.text().catch(() => undefined);
        expect(`${route.method} ${route.path} → ${res.status}`).toBe(
          `${route.method} ${route.path} → 401`,
        );
      }
    });

    it('enforces tenant binding on every wiki route (cross-tenant → 403)', async () => {
      const base = await setup(13141, { apiKeys: [{ key: 'key-a', tenantId: 'tenant-a' }] });
      for (const route of NEW_ROUTES) {
        const res = await fetch(`${base}${route.path}`, {
          method: route.method,
          headers: {
            Authorization: 'Bearer key-a',
            'Content-Type': 'application/json',
            'x-memory-tenant': 'tenant-b',
            'x-memory-system': 'sys',
            'x-memory-scope': 'task',
          },
          body: route.body ? JSON.stringify(route.body) : undefined,
        });
        await res.text().catch(() => undefined);
        expect(`${route.method} ${route.path} → ${res.status}`).toBe(
          `${route.method} ${route.path} → 403`,
        );
      }
    });
  });
});
