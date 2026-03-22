import { execFile as execFileCallback } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { startHttpServer } from '../../dist/server/http-server.js';

const execFile = promisify(execFileCallback);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

async function runCommand(command, args, cwd) {
  const { stdout, stderr } = await execFile(command, args, {
    cwd,
    env: process.env,
  });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

async function loadHostedTrace() {
  const raw = await readFile(path.join(repoRoot, 'evals', 'traces', 'hosted-shared-memory.json'), 'utf8');
  return JSON.parse(raw);
}

export async function runPlatformQualityEval() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'memory-layer-platform-'));
  const dbPath = path.join(tempDir, 'platform.db');
  const pythonDir = path.join(repoRoot, 'clients', 'python');
  const pythonExecutable = path.join(pythonDir, '.venv', 'bin', 'python');
  const fact = 'Platform gate remembers rollback playbooks.';
  const scope = {
    tenant_id: 'eval',
    system_id: 'hosted',
    scope_id: 'run-1',
  };

  let serverInstance;

  try {
    const hostedTrace = await loadHostedTrace();
    serverInstance = await startHttpServer({
      port: 0,
      dbPath,
    });
    const address = serverInstance.server.address();
    const port = typeof address === 'object' && address ? address.port : 3100;
    const baseUrl = `http://127.0.0.1:${port}`;
    const since = new Date().toISOString();

    await fetch(`${baseUrl}/v1/facts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fact,
        factType: 'reference',
        scope,
      }),
    });

    const inspectResponse = await fetch(
      `${baseUrl}/v1/inspect/knowledge?tenant_id=${scope.tenant_id}&system_id=${scope.system_id}&scope_id=${scope.scope_id}&limit=10`,
    );
    const inspectPayload = await inspectResponse.json();
    const knowledgeId = inspectPayload.items?.[0]?.id ?? null;

    const nodeCli = await runCommand(
      process.execPath,
      [
        './bin/memory-server.mjs',
        'inspect',
        'knowledge',
        '--db',
        dbPath,
        '--tenant',
        scope.tenant_id,
        '--system',
        scope.system_id,
        '--scope-id',
        scope.scope_id,
        '--limit',
        '10',
      ],
      repoRoot,
    );

    const pythonAvailable = existsSync(pythonExecutable);
    const pythonInspect = pythonAvailable
      ? await runCommand(
          pythonExecutable,
          [
            '-m',
            'memory_layer_client.cli',
            '--base-url',
            baseUrl,
            'inspect-knowledge',
            '--knowledge-id',
            String(knowledgeId),
            '--tenant-id',
            scope.tenant_id,
            '--system-id',
            scope.system_id,
            '--scope-id',
            scope.scope_id,
          ],
          pythonDir,
        )
      : { stdout: '', stderr: 'python client venv missing' };

    const pythonChanges = pythonAvailable
      ? await runCommand(
          pythonExecutable,
          [
            '-m',
            'memory_layer_client.cli',
            '--base-url',
            baseUrl,
            'changes',
            '--since',
            since,
            '--tenant-id',
            scope.tenant_id,
            '--system-id',
            scope.system_id,
            '--scope-id',
            scope.scope_id,
          ],
          pythonDir,
        )
      : { stdout: '', stderr: 'python client venv missing' };

    for (const item of hostedTrace.facts) {
      await fetch(`${baseUrl}/v1/facts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fact: item.fact,
          factType: item.factType,
          scope: item.scope,
        }),
      });
    }

    const searchScope = hostedTrace.searchScope;
    const hostedCrossScope = await fetch(
      `${baseUrl}/v1/search/cross-scope?q=${encodeURIComponent(hostedTrace.crossScopeQuery)}&scope_level=${hostedTrace.scopeLevel}&tenant_id=${searchScope.tenant_id}&system_id=${searchScope.system_id}&workspace_id=${searchScope.workspace_id}&collaboration_id=${searchScope.collaboration_id}&scope_id=${searchScope.scope_id}`,
    );
    const hostedCrossScopePayload = await hostedCrossScope.json();
    const hostedChanges = await fetch(
      `${baseUrl}/v1/changes?since=${encodeURIComponent(hostedTrace.since)}&scope_level=${hostedTrace.scopeLevel}&tenant_id=${searchScope.tenant_id}&system_id=${searchScope.system_id}&workspace_id=${searchScope.workspace_id}&collaboration_id=${searchScope.collaboration_id}&scope_id=${searchScope.scope_id}`,
    );
    const hostedChangesPayload = await hostedChanges.json();

    const checks = [
      {
        name: 'hosted_inspect_route',
        passed:
          inspectResponse.ok &&
          Array.isArray(inspectPayload.items) &&
          String(inspectPayload.items[0]?.fact ?? '').includes('rollback playbooks'),
        detail: inspectPayload,
      },
      {
        name: 'node_inspect_cli',
        passed: nodeCli.stdout.includes('rollback playbooks'),
        detail: nodeCli.stdout,
      },
      {
        name: 'python_inspect_cli',
        passed: pythonAvailable && pythonInspect.stdout.includes('rollback playbooks'),
        detail: pythonAvailable ? pythonInspect.stdout : pythonInspect.stderr,
      },
      {
        name: 'python_changes_cli',
        passed: pythonAvailable && pythonChanges.stdout.includes('rollback playbooks'),
        detail: pythonAvailable ? pythonChanges.stdout : pythonChanges.stderr,
      },
      {
        name: 'hosted_shared_memory_cross_scope_replay',
        passed:
          hostedCrossScope.ok &&
          Array.isArray(hostedCrossScopePayload.knowledge) &&
          hostedCrossScopePayload.knowledge.some((item) =>
            String(item.fact ?? '').includes(hostedTrace.expectedFact),
          ),
        detail: hostedCrossScopePayload,
      },
      {
        name: 'hosted_shared_memory_change_replay',
        passed:
          hostedChanges.ok &&
          Array.isArray(hostedChangesPayload.changes) &&
          hostedChangesPayload.changes.some((item) =>
            String(item.fact ?? '').includes(hostedTrace.expectedFact),
          ),
        detail: hostedChangesPayload,
      },
    ];

    return {
      eval: 'platform-quality',
      passed: checks.every((check) => check.passed),
      checks,
    };
  } finally {
    if (serverInstance) {
      await serverInstance.close();
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const shouldEnforce = process.argv.includes('--enforce');
  const result = await runPlatformQualityEval();
  console.log(JSON.stringify(result, null, 2));

  if (shouldEnforce && !result.passed) {
    process.exit(1);
  }
}
