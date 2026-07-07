import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// docker-entrypoint.sh cannot be run under Docker on this machine, so we
// validate its guard logic by shelling out directly with env combinations and
// asserting the exit codes. exit 78 = refuse (EX_CONFIG); exit 0 = passed guard
// (the trailing `exec "$@"` runs our harmless command).

const here = dirname(fileURLToPath(import.meta.url));
const entrypoint = join(here, '..', '..', 'docker-entrypoint.sh');

/** Run the entrypoint with the given env; the exec target is `true` (exit 0). */
function runGuard(env: Record<string, string>): number {
  return runGuardArgs(env, ['true']);
}

/**
 * Run the entrypoint with the given env AND a specific command line (the args
 * the entrypoint receives as "$@" and would exec). The command line always ends
 * in a harmless `true` so a passed guard exits 0. Use this to exercise the
 * flag-vs-env precedence the server itself applies (--transport/--host win over
 * the env vars).
 */
function runGuardArgs(env: Record<string, string>, cmd: string[]): number {
  const result = spawnSync('sh', [entrypoint, ...cmd], {
    env: { PATH: process.env.PATH ?? '', ...env },
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  return result.status ?? -1;
}

const REFUSE = 78;
const PASS = 0;

describe('docker-entrypoint guard matrix (transport x host x key x opt-out)', () => {
  // The dangerous cell: HTTP on a non-loopback host with no key and no opt-out.
  it('refuses http on 0.0.0.0 with no key and no opt-out', () => {
    expect(runGuard({ MEMORY_TRANSPORT: 'http', MEMORY_HOST: '0.0.0.0' })).toBe(REFUSE);
  });

  it('refuses transport=both on 0.0.0.0 with no key', () => {
    expect(runGuard({ MEMORY_TRANSPORT: 'both', MEMORY_HOST: '0.0.0.0' })).toBe(REFUSE);
  });

  it('refuses http on an external hostname with no key', () => {
    expect(runGuard({ MEMORY_TRANSPORT: 'http', MEMORY_HOST: 'memory.example.com' })).toBe(REFUSE);
  });

  it('passes http on 0.0.0.0 when MEMORY_API_KEY is set', () => {
    expect(
      runGuard({ MEMORY_TRANSPORT: 'http', MEMORY_HOST: '0.0.0.0', MEMORY_API_KEY: 'secret' }),
    ).toBe(PASS);
  });

  it('passes http on 0.0.0.0 when MEMORY_API_KEYS registry is set', () => {
    expect(
      runGuard({
        MEMORY_TRANSPORT: 'http',
        MEMORY_HOST: '0.0.0.0',
        MEMORY_API_KEYS: 'k1:tenantA',
      }),
    ).toBe(PASS);
  });

  it('passes http on 0.0.0.0 with explicit MEMORY_ALLOW_UNAUTHENTICATED=1 opt-out', () => {
    expect(
      runGuard({
        MEMORY_TRANSPORT: 'http',
        MEMORY_HOST: '0.0.0.0',
        MEMORY_ALLOW_UNAUTHENTICATED: '1',
      }),
    ).toBe(PASS);
  });

  it('does not treat MEMORY_ALLOW_UNAUTHENTICATED=0 as an opt-out', () => {
    expect(
      runGuard({
        MEMORY_TRANSPORT: 'http',
        MEMORY_HOST: '0.0.0.0',
        MEMORY_ALLOW_UNAUTHENTICATED: '0',
      }),
    ).toBe(REFUSE);
  });

  // Backward compatibility: loopback + keyless must keep working.
  it('passes http on 127.0.0.1 with no key (loopback is exempt)', () => {
    expect(runGuard({ MEMORY_TRANSPORT: 'http', MEMORY_HOST: '127.0.0.1' })).toBe(PASS);
  });

  it('passes http on localhost with no key', () => {
    expect(runGuard({ MEMORY_TRANSPORT: 'http', MEMORY_HOST: 'localhost' })).toBe(PASS);
  });

  it('passes http on ::1 with no key', () => {
    expect(runGuard({ MEMORY_TRANSPORT: 'http', MEMORY_HOST: '::1' })).toBe(PASS);
  });

  // Non-HTTP transports have no network surface and are always allowed.
  it('passes mcp transport on 0.0.0.0 with no key (no HTTP listener)', () => {
    expect(runGuard({ MEMORY_TRANSPORT: 'mcp', MEMORY_HOST: '0.0.0.0' })).toBe(PASS);
  });

  it('passes when transport is unset (defaults to mcp)', () => {
    expect(runGuard({ MEMORY_HOST: '0.0.0.0' })).toBe(PASS);
  });

  it('passes when host is unset (defaults to 127.0.0.1) even for http', () => {
    expect(runGuard({ MEMORY_TRANSPORT: 'http' })).toBe(PASS);
  });
});

describe('finding 1 — guard reflects the actual command line, not just env', () => {
  // The server honors --transport over MEMORY_TRANSPORT. The old guard read the
  // env var only, so `-e MEMORY_TRANSPORT=mcp` with a CMD that still serves
  // http let the guard say OK while the server served unauthenticated http.
  it('refuses when --transport http overrides MEMORY_TRANSPORT=mcp (no key)', () => {
    expect(
      runGuardArgs(
        { MEMORY_TRANSPORT: 'mcp', MEMORY_HOST: '0.0.0.0' },
        ['true', 'serve', '--transport', 'http', 'true'],
      ),
    ).toBe(REFUSE);
  });

  // Symmetric direction: an explicit --transport mcp genuinely disables HTTP, so
  // even with MEMORY_TRANSPORT=http and no key the server has no network surface.
  it('passes when --transport mcp overrides MEMORY_TRANSPORT=http (no HTTP served)', () => {
    expect(
      runGuardArgs(
        { MEMORY_TRANSPORT: 'http', MEMORY_HOST: '0.0.0.0' },
        ['true', 'serve', '--transport', 'mcp', 'true'],
      ),
    ).toBe(PASS);
  });

  // --host on the command line also wins over the env var (server precedence).
  it('refuses when --host 0.0.0.0 overrides a loopback MEMORY_HOST (http, no key)', () => {
    expect(
      runGuardArgs(
        { MEMORY_TRANSPORT: 'http', MEMORY_HOST: '127.0.0.1' },
        ['true', 'serve', '--host', '0.0.0.0', 'true'],
      ),
    ).toBe(REFUSE);
  });

  it('passes when --host 127.0.0.1 overrides MEMORY_HOST=0.0.0.0 (http, no key)', () => {
    expect(
      runGuardArgs(
        { MEMORY_TRANSPORT: 'http', MEMORY_HOST: '0.0.0.0' },
        ['true', 'serve', '--host', '127.0.0.1', 'true'],
      ),
    ).toBe(PASS);
  });
});

describe('finding 2 — empty MEMORY_HOST must not fail open', () => {
  // The server uses nullish coalescing: unset host -> 127.0.0.1 (safe), but an
  // EMPTY host stays "" and Node binds every interface. The old guard used
  // ${MEMORY_HOST:-127.0.0.1} (empty substituted to loopback) and treated "" as
  // loopback, so an empty host with no key exited 0 while the server bound all
  // interfaces unauthenticated.
  it('refuses http with an explicitly empty MEMORY_HOST and no key', () => {
    expect(runGuard({ MEMORY_TRANSPORT: 'http', MEMORY_HOST: '' })).toBe(REFUSE);
  });

  it('refuses http with an explicitly empty --host and no key', () => {
    expect(
      runGuardArgs({ MEMORY_TRANSPORT: 'http' }, ['true', '--host', '', 'true']),
    ).toBe(REFUSE);
  });

  it('still passes http with an empty host when a key is set', () => {
    expect(
      runGuard({ MEMORY_TRANSPORT: 'http', MEMORY_HOST: '', MEMORY_API_KEY: 'secret' }),
    ).toBe(PASS);
  });
});
