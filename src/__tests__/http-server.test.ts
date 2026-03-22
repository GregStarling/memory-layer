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
});
