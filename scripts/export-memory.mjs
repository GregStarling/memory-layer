import fs from 'node:fs';
import Database from 'better-sqlite3';

/**
 * Scoped memory export.
 *
 * By default this refuses to export the whole database. You must either name a
 * tenant (--tenant <id>, plus optional finer scope) or explicitly opt into a
 * full dump with --all-tenants. Every scoped table's SELECT is filtered by the
 * provided scope columns so a tenant-A export can never leak tenant-B rows.
 *
 * Metadata tables (see METADATA_TABLES) have no scope columns and are exported
 * verbatim — they describe the database, not any tenant's data.
 *
 * Usage:
 *   node scripts/export-memory.mjs <db-path> <output-json> --tenant <id> \
 *     [--system <id>] [--workspace <id>] [--collaboration <id>] [--scope <id>]
 *   node scripts/export-memory.mjs <db-path> <output-json> --all-tenants
 */

// Tables that carry the standard five-column scope prefix
// (tenant_id, system_id, workspace_id, collaboration_id, scope_id) in
// src/adapters/sqlite/schema.ts. Every table here is filtered by the requested
// scope on export, so a tenant-A export can never leak tenant-B rows.
//
// This list MUST include every tenant-scoped domain table, or a scoped export is
// silently lossy (backup/migrate drops the omitted tables). Each entry below was
// confirmed against the schema to have a tenant_id column:
//   turns, working_memory, knowledge_memory, knowledge_memory_audit,
//   knowledge_candidate, knowledge_evidence, context_monitor, compaction_log,
//   work_items                              — the original core set
//   playbooks, playbook_revisions, associations, handoff_records,
//   source_documents, scope_config, context_contracts, context_invariants,
//   context_escalation_policies             — added (they were being dropped)
//
// Deliberately EXCLUDED even though they carry tenant_id (see report):
//   memory_event_log, session_state_current, work_claims_current,
//   work_claims_history, projection_watermarks — the event-sourcing / projection
//   substrate. Copying raw event ids + projection watermarks across databases
//   would corrupt the append-only log's monotonic ids and the cutover state;
//   these are rebuilt from the domain tables, not migrated verbatim.
//   projection_watermarks additionally has no scope columns.
export const SCOPED_TABLES = [
  'turns',
  'working_memory',
  'knowledge_memory',
  'knowledge_memory_audit',
  'knowledge_candidate',
  'knowledge_evidence',
  'context_monitor',
  'compaction_log',
  'work_items',
  'playbooks',
  'playbook_revisions',
  'associations',
  'handoff_records',
  'source_documents',
  'scope_config',
  'context_contracts',
  'context_invariants',
  'context_escalation_policies',
];

// Tables without scope columns. Exported as-is regardless of --tenant.
export const METADATA_TABLES = ['schema_meta'];

const SCOPE_FLAGS = {
  '--tenant': 'tenant_id',
  '--system': 'system_id',
  '--workspace': 'workspace_id',
  '--collaboration': 'collaboration_id',
  '--scope': 'scope_id',
};

export function parseExportArgs(argv) {
  const positional = [];
  const scope = {};
  let allTenants = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--all-tenants') {
      allTenants = true;
    } else if (SCOPE_FLAGS[arg] !== undefined) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`Missing value for ${arg}`);
      }
      scope[SCOPE_FLAGS[arg]] = value;
      i += 1;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  const [dbPath, outputPath] = positional;

  if (!allTenants && scope.tenant_id === undefined) {
    throw new Error(
      'Refusing to export: pass --tenant <id> to scope the export, or --all-tenants to dump every tenant.',
    );
  }

  return { dbPath, outputPath, scope, allTenants };
}

/**
 * Build the WHERE clause + params for a scoped table given the requested scope.
 * Returns { clause: '' , params: [] } when no scope columns were provided
 * (only possible under --all-tenants).
 */
export function buildScopeFilter(scope) {
  const columns = Object.keys(scope);
  if (columns.length === 0) return { clause: '', params: [] };
  const clause = ` WHERE ${columns.map((c) => `${c} = ?`).join(' AND ')}`;
  const params = columns.map((c) => scope[c]);
  return { clause, params };
}

export function exportMemory(db, { scope, allTenants }) {
  const { clause, params } = allTenants ? { clause: '', params: [] } : buildScopeFilter(scope);

  const payload = {};
  for (const table of SCOPED_TABLES) {
    payload[table] = db.prepare(`SELECT * FROM ${table}${clause}`).all(...params);
  }
  for (const table of METADATA_TABLES) {
    payload[table] = db.prepare(`SELECT * FROM ${table}`).all();
  }
  return payload;
}

function main() {
  let parsed;
  try {
    parsed = parseExportArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    console.error(
      '\nUsage: node scripts/export-memory.mjs <db-path> <output-json> --tenant <id> [--system <id>] [--workspace <id>] [--collaboration <id>] [--scope <id>]',
    );
    console.error('       node scripts/export-memory.mjs <db-path> <output-json> --all-tenants');
    process.exit(1);
  }

  const { dbPath, outputPath, scope, allTenants } = parsed;
  if (!dbPath || !outputPath) {
    console.error('Usage: node scripts/export-memory.mjs <db-path> <output-json> --tenant <id>');
    process.exit(1);
  }

  const db = new Database(dbPath, { readonly: true });
  try {
    const payload = exportMemory(db, { scope, allTenants });
    fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2));
  } finally {
    db.close();
  }
}

// Only run when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
