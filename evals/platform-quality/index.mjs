import { execFile as execFileCallback } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { startHttpServer } from '../../dist/server/http-server.js';

const execFile = promisify(execFileCallback);
const shouldEnforce = process.argv.includes('--enforce');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

async function runCommand(command, args, cwd) {
  const { stdout, stderr } = await execFile(command, args, {
    cwd,
    env: process.env,
  });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

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
  ];

  const result = {
    eval: 'platform-quality',
    passed: checks.every((check) => check.passed),
    checks,
  };

  console.log(JSON.stringify(result, null, 2));

  if (shouldEnforce && !result.passed) {
    process.exit(1);
  }
} finally {
  if (serverInstance) {
    await serverInstance.close();
  }
  await rm(tempDir, { recursive: true, force: true });
}
