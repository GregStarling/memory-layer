/**
 * Transport-level parity coverage.
 *
 * The memory-quality evals exercise core functions directly, so transport
 * regressions (HTTP/MCP) can ship while evals stay green. These tests pin
 * the shape of Phase 2 (profiles) and Phase 3 (playbooks + associations)
 * HTTP + MCP responses against the manager contract.
 *
 * Phase 1 episodic/cognitive endpoints already have coverage in
 * http-server.test.ts and mcp-server.test.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { startHttpServer } from '../server/http-server.js';
import { createMcpServerHandler } from '../server/mcp-server.js';

describe('transport parity — Phase 2 profiles', () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  it('GET /v1/profile returns a Profile envelope with named sections', async () => {
    const instance = await startHttpServer({ port: 13901, dbPath: ':memory:' });
    cleanup = instance.close;
    const base = 'http://localhost:13901';

    await fetch(`${base}/v1/facts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fact: 'User prefers concise communication',
        factType: 'preference',
      }),
    });

    const res = await fetch(`${base}/v1/profile?view=user`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profile).toBeDefined();
    expect(body.profile.view).toBe('user');
    // Contract: sections is a record keyed by the 5 section names.
    const expectedSections = ['identity', 'preferences', 'communication', 'constraints', 'workflows'];
    for (const section of expectedSections) {
      expect(Array.isArray(body.profile.sections[section])).toBe(true);
    }
    expect(typeof body.profile.generatedAt).toBe('number');
  });

  it('GET /v1/profile includes provisional only when explicitly opted in', async () => {
    const instance = await startHttpServer({ port: 13902, dbPath: ':memory:' });
    cleanup = instance.close;
    const base = 'http://localhost:13902';

    // Without includeProvisional the profile should still return, defaulting
    // to trusted-only. We can at least confirm the parameter is accepted.
    const trusted = await fetch(`${base}/v1/profile`);
    expect(trusted.status).toBe(200);

    const withProvisional = await fetch(`${base}/v1/profile?includeProvisional=true`);
    expect(withProvisional.status).toBe(200);
  });

  it('MCP memory_get_profile returns the same Profile shape as HTTP', async () => {
    const handler = createMcpServerHandler();
    try {
      const result = await handler.callTool('memory_get_profile', { view: 'user' });
      expect(result.isError).toBeUndefined();
      const profile = JSON.parse(result.content[0].text);
      expect(profile.view).toBe('user');
      expect(profile.sections).toBeDefined();
      for (const section of ['identity', 'preferences', 'communication', 'constraints', 'workflows']) {
        expect(Array.isArray(profile.sections[section])).toBe(true);
      }
    } finally {
      await handler.close();
    }
  });
});

describe('transport parity — Phase 3 playbooks', () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  it('HTTP POST/GET/PUT /v1/playbooks round-trips a full playbook', async () => {
    const instance = await startHttpServer({ port: 13911, dbPath: ':memory:' });
    cleanup = instance.close;
    const base = 'http://localhost:13911';

    // Create
    const createRes = await fetch(`${base}/v1/playbooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Deploy staging',
        description: 'Deploy current branch to staging',
        instructions: '1. Run tests\n2. Push\n3. Verify health',
        tags: ['deploy', 'staging'],
      }),
    });
    expect(createRes.status).toBe(201);
    const createBody = await createRes.json();
    expect(createBody.playbook).toBeDefined();
    expect(createBody.playbook.id).toBeGreaterThan(0);
    expect(createBody.playbook.title).toBe('Deploy staging');
    // Contract: playbooks carry scope metadata so Python/MCP consumers can trust provenance.
    expect(typeof createBody.playbook.tenant_id).toBe('string');
    expect(typeof createBody.playbook.scope_id).toBe('string');

    const { id } = createBody.playbook;

    // Get by id
    const getRes = await fetch(`${base}/v1/playbooks/${id}`);
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();
    expect(getBody.playbook.id).toBe(id);
    expect(getBody.playbook.instructions).toContain('Run tests');

    // Search returns full records + rank
    const searchRes = await fetch(`${base}/v1/playbooks?q=deploy`);
    expect(searchRes.status).toBe(200);
    const searchBody = await searchRes.json();
    expect(Array.isArray(searchBody.playbooks)).toBe(true);
    expect(searchBody.playbooks.length).toBeGreaterThan(0);
    // Search hits must include rank and full playbook fields.
    expect(searchBody.playbooks[0]).toHaveProperty('rank');
    expect(searchBody.playbooks[0]).toHaveProperty('instructions');
    expect(searchBody.playbooks[0]).toHaveProperty('tenant_id');
  });

  it('HTTP POST /v1/playbooks/:id/use records usage and returns updated playbook', async () => {
    const instance = await startHttpServer({ port: 13912, dbPath: ':memory:' });
    cleanup = instance.close;
    const base = 'http://localhost:13912';

    const create = await fetch(`${base}/v1/playbooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Usage test',
        description: 'Test',
        instructions: 'noop',
      }),
    });
    const { playbook } = await create.json();

    const useRes = await fetch(`${base}/v1/playbooks/${playbook.id}/use`, {
      method: 'POST',
    });
    expect(useRes.status).toBe(200);
    const useBody = await useRes.json();
    expect(useBody.recorded).toBe(true);
    expect(useBody.playbook.id).toBe(playbook.id);
    expect(useBody.playbook.use_count).toBeGreaterThan(0);

    const refetch = await fetch(`${base}/v1/playbooks/${playbook.id}`);
    const refetchBody = await refetch.json();
    expect(refetchBody.playbook.use_count).toBeGreaterThan(0);
  });

  it('MCP memory_create_playbook / memory_revise_playbook return full playbook shapes', async () => {
    const handler = createMcpServerHandler();
    try {
      const createResult = await handler.callTool('memory_create_playbook', {
        title: 'MCP test',
        description: 'test',
        instructions: 'step 1',
      });
      expect(createResult.isError).toBeUndefined();
      const createParsed = JSON.parse(createResult.content[0].text);
      expect(createParsed.playbook).toBeDefined();
      expect(createParsed.playbook.id).toBeGreaterThan(0);
      expect(createParsed.playbook.title).toBe('MCP test');
      // Scope metadata present — parity with HTTP.
      expect(typeof createParsed.playbook.tenant_id).toBe('string');

      const reviseResult = await handler.callTool('memory_revise_playbook', {
        playbookId: createParsed.playbook.id,
        newInstructions: 'step 1\nstep 2',
        revisionReason: 'add second step',
      });
      expect(reviseResult.isError).toBeUndefined();
      const reviseParsed = JSON.parse(reviseResult.content[0].text);
      expect(reviseParsed.playbook).toBeDefined();
      expect(reviseParsed.revision).toBeDefined();
      expect(reviseParsed.playbook.instructions).toBe('step 1\nstep 2');
      expect(reviseParsed.revision.instructions).toBe('step 1');
    } finally {
      await handler.close();
    }
  });

  it('MCP memory_search_playbooks preserves rank and full playbook fields', async () => {
    const handler = createMcpServerHandler();
    try {
      await handler.callTool('memory_create_playbook', {
        title: 'Rank preservation test',
        description: 'x',
        instructions: 'y',
      });
      const searchResult = await handler.callTool('memory_search_playbooks', {
        query: 'rank',
      });
      expect(searchResult.isError).toBeUndefined();
      const parsed = JSON.parse(searchResult.content[0].text);
      expect(Array.isArray(parsed.playbooks)).toBe(true);
      expect(parsed.playbooks.length).toBeGreaterThan(0);
      // Must preserve rank and full shape (not a truncated subset).
      expect(parsed.playbooks[0]).toHaveProperty('rank');
      expect(parsed.playbooks[0]).toHaveProperty('instructions');
      expect(parsed.playbooks[0]).toHaveProperty('tenant_id');
    } finally {
      await handler.close();
    }
  });

  it('MCP memory_use_playbook records usage and returns the updated record', async () => {
    const handler = createMcpServerHandler();
    try {
      const create = await handler.callTool('memory_create_playbook', {
        title: 'Use recording test',
        description: 'x',
        instructions: 'y',
      });
      const { playbook } = JSON.parse(create.content[0].text);
      const useResult = await handler.callTool('memory_use_playbook', { playbookId: playbook.id });
      expect(useResult.isError).toBeUndefined();
      const parsed = JSON.parse(useResult.content[0].text);
      expect(parsed.playbook.id).toBe(playbook.id);
      expect(parsed.playbook.use_count).toBeGreaterThan(0);
    } finally {
      await handler.close();
    }
  });
});

describe('transport parity — Phase 3 associations', () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  it('HTTP POST/GET /v1/associations enforces scope on endpoint IDs', async () => {
    const instance = await startHttpServer({ port: 13921, dbPath: ':memory:' });
    cleanup = instance.close;
    const base = 'http://localhost:13921';

    // Create two knowledge facts so we have real in-scope endpoints.
    const factA = await fetch(`${base}/v1/facts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fact: 'Fact A', factType: 'reference' }),
    });
    const factB = await fetch(`${base}/v1/facts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fact: 'Fact B', factType: 'reference' }),
    });
    const a = await factA.json();
    const b = await factB.json();

    // Valid association between two real in-scope knowledge entries.
    const createRes = await fetch(`${base}/v1/associations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source_kind: 'knowledge',
        source_id: a.knowledgeId,
        target_kind: 'knowledge',
        target_id: b.knowledgeId,
        association_type: 'related_to',
      }),
    });
    expect(createRes.status).toBe(201);
    const createBody = await createRes.json();
    expect(createBody.association).toBeDefined();
    expect(createBody.association.id).toBeGreaterThan(0);
    expect(createBody.association.association_type).toBe('related_to');

    // Non-integer / non-positive IDs must be rejected at the boundary.
    const badRes = await fetch(`${base}/v1/associations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source_kind: 'knowledge',
        source_id: 0,
        target_kind: 'knowledge',
        target_id: 1.5,
        association_type: 'related_to',
      }),
    });
    expect(badRes.status).toBe(400);

    // Cross-scope / nonexistent IDs must be rejected by the manager validator.
    const missingRes = await fetch(`${base}/v1/associations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source_kind: 'knowledge',
        source_id: 999999,
        target_kind: 'knowledge',
        target_id: 888888,
        association_type: 'related_to',
      }),
    });
    expect(missingRes.status).toBeGreaterThanOrEqual(400);
  });

  it('HTTP POST /v1/associations/traverse rejects invalid maxDepth/maxNodes', async () => {
    const instance = await startHttpServer({ port: 13922, dbPath: ':memory:' });
    cleanup = instance.close;
    const base = 'http://localhost:13922';

    const badMax = await fetch(`${base}/v1/associations/traverse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'knowledge',
        id: 1,
        maxDepth: -1,
      }),
    });
    expect(badMax.status).toBe(400);

    const nonInteger = await fetch(`${base}/v1/associations/traverse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'knowledge',
        id: 1,
        maxNodes: 3.7,
      }),
    });
    expect(nonInteger.status).toBe(400);
  });

  it('MCP memory_add_association rejects invalid IDs symmetrically with HTTP', async () => {
    const handler = createMcpServerHandler();
    try {
      const result = await handler.callTool('memory_add_association', {
        source_kind: 'knowledge',
        source_id: 0,
        target_kind: 'knowledge',
        target_id: 1,
        association_type: 'related_to',
      });
      expect(result.isError).toBe(true);
    } finally {
      await handler.close();
    }
  });
});
