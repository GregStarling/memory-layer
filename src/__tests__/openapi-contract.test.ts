/**
 * OpenAPI schema-driven contract validation.
 *
 * Parses `openapi.yaml` at test time and checks that HTTP endpoint responses
 * structurally match their declared response schemas. This is the
 * enforcement layer the review flagged as missing — the transport parity
 * tests pin shape by example, but this test pins shape by *spec*. If the
 * server stops matching what `openapi.yaml` declares, this test fails.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { startHttpServer } from '../server/http-server.js';
import {
  assertMatchesOpenApi,
  loadOpenApi,
  parseYaml,
} from './helpers/openapi-validator.js';

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

  async function setup(port: number) {
    const instance = await startHttpServer({ port, dbPath: ':memory:' });
    cleanup = instance.close;
    return `http://localhost:${port}`;
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
    assertMatchesOpenApi('/v1/context', 'get', '200', body);
  });
});
