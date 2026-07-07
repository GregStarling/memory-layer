import fs from 'node:fs';
import Database from 'better-sqlite3';

/**
 * Scoped, non-destructive memory import.
 *
 * Behavioural contract (changed from the old INSERT OR REPLACE):
 *   - Plain INSERT. An id collision with an existing row aborts the whole
 *     import inside a single transaction: nothing is written, and the process
 *     exits non-zero reporting the collision count. The old behaviour silently
 *     overwrote rows by id — including across tenants — which is data loss.
 *   - --remap-ids inserts every row under a fresh autoincrement id and rewrites
 *     the foreign keys between exported tables so internal references survive
 *     (see FOREIGN_KEYS). Use this to merge an export into a populated database.
 *   - Rows whose tenant_id does not match the declared --tenant are refused
 *     unless --all-tenants is passed. This stops a mislabelled or hostile export
 *     from writing into another tenant's space.
 *
 * Usage:
 *   node scripts/import-memory.mjs <db-path> <input-json> --tenant <id> [--remap-ids]
 *   node scripts/import-memory.mjs <db-path> <input-json> --all-tenants [--remap-ids]
 */

import { SCOPED_TABLES, METADATA_TABLES } from './export-memory.mjs';

/**
 * Foreign keys between exported tables, keyed by child table. Each entry maps a
 * child column to the parent table whose id it references. Only references among
 * tables we actually export are listed (references to non-exported tables such
 * as playbooks are irrelevant to a scoped export/import round-trip).
 *
 * Self-references (e.g. knowledge_memory.superseded_by_id) are included and
 * resolved in the same fixup pass, since all ids are known once every row is
 * inserted.
 */
export const FOREIGN_KEYS = {
  turns: { compaction_log_id: 'compaction_log' },
  working_memory: { promoted_to_knowledge_id: 'knowledge_memory' },
  knowledge_memory: {
    source_working_memory_id: 'working_memory',
    superseded_by_id: 'knowledge_memory',
  },
  knowledge_memory_audit: {
    working_memory_id: 'working_memory',
    created_knowledge_id: 'knowledge_memory',
    related_knowledge_id: 'knowledge_memory',
  },
  knowledge_candidate: {
    working_memory_id: 'working_memory',
    promoted_knowledge_id: 'knowledge_memory',
  },
  knowledge_evidence: {
    knowledge_memory_id: 'knowledge_memory',
    knowledge_candidate_id: 'knowledge_candidate',
    working_memory_id: 'working_memory',
    turn_id: 'turns',
  },
  compaction_log: { working_memory_id: 'working_memory' },
  work_items: { source_working_memory_id: 'working_memory' },
  playbooks: { source_working_memory_id: 'working_memory' },
  playbook_revisions: { playbook_id: 'playbooks' },
  handoff_records: { work_item_id: 'work_items' },
  // associations use polymorphic (source_kind, source_id)/(target_kind,
  // target_id) references, not plain FK columns, so they cannot be remapped by
  // this generic id-rewrite pass; they are exported/imported verbatim.
};

export function parseImportArgs(argv) {
  const positional = [];
  let tenant;
  let allTenants = false;
  let remapIds = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--all-tenants') {
      allTenants = true;
    } else if (arg === '--remap-ids') {
      remapIds = true;
    } else if (arg === '--tenant') {
      tenant = argv[i + 1];
      if (tenant === undefined || tenant.startsWith('--')) {
        throw new Error('Missing value for --tenant');
      }
      i += 1;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  const [dbPath, inputPath] = positional;

  if (!allTenants && tenant === undefined) {
    throw new Error(
      'Refusing to import: pass --tenant <id> to declare the target tenant, or --all-tenants to allow every tenant.',
    );
  }

  return { dbPath, inputPath, tenant, allTenants, remapIds };
}

class ImportError extends Error {}

// The complete set of table names this import is ever allowed to write to. Any
// payload key outside this set is rejected: a crafted export could otherwise
// name an arbitrary (or tenant-scoped-but-unchecked) table and have its rows
// inserted, bypassing the --tenant guard (which only iterates SCOPED_TABLES).
// METADATA_TABLES are allow-listed for recognition but never written (they
// describe the target DB itself).
const ALLOWED_TABLES = new Set([...SCOPED_TABLES, ...METADATA_TABLES]);

/**
 * Reject any payload key that is not a known table. This is both a safety guard
 * (an unknown/hostile table key never reaches an INSERT) and the enforcement
 * point for finding 4: tables carrying tenant_id that are NOT in SCOPED_TABLES
 * would otherwise slip past the tenant-match check.
 */
function assertKnownTables(payload) {
  for (const table of Object.keys(payload)) {
    if (!ALLOWED_TABLES.has(table)) {
      throw new ImportError(
        `Refusing to import: payload contains unknown table "${table}". ` +
          `Only these tables may be imported: ${[...ALLOWED_TABLES].join(', ')}.`,
      );
    }
  }
}

/**
 * Return the set of real column names for `table` from the live DB schema. Used
 * to whitelist every column name before it is string-interpolated into an
 * INSERT — attacker-controllable JSON keys must never reach the SQL text
 * unvalidated (finding 5). `table` must already have been checked against
 * ALLOWED_TABLES so PRAGMA table_info receives a known identifier.
 */
function schemaColumns(db, table) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return new Set(rows.map((r) => r.name));
}

/**
 * Validate that `table` is allow-listed and every `columns` entry is a real
 * column of that table, then return a safe { quotedTable, quotedColumns } for
 * interpolation. Throws ImportError on any unknown table or column so nothing
 * unsafe is ever interpolated into SQL.
 */
function safeInsertIdentifiers(db, table, columns) {
  if (!ALLOWED_TABLES.has(table)) {
    throw new ImportError(`Refusing to import into unknown table "${table}".`);
  }
  const known = schemaColumns(db, table);
  for (const column of columns) {
    if (!known.has(column)) {
      throw new ImportError(
        `Refusing to import: column "${column}" does not exist on table "${table}".`,
      );
    }
  }
  // Identifiers are validated against the schema; double-quote them defensively.
  return {
    quotedTable: `"${table}"`,
    quotedColumns: columns.map((c) => `"${c}"`),
  };
}

/**
 * Perform the import against an open better-sqlite3 database inside a single
 * transaction. Throws ImportError (leaving the DB untouched) on any collision,
 * cross-tenant row, or missing table. Returns a small summary on success.
 */
export function importMemory(db, payload, { tenant, allTenants, remapIds }) {
  // Reject any table key we do not recognize BEFORE anything else, so a hostile
  // payload naming an unknown or unchecked table never reaches an INSERT.
  assertKnownTables(payload);

  // Validate tenant scoping up front so a bad export writes nothing.
  if (!allTenants) {
    for (const table of SCOPED_TABLES) {
      const rows = payload[table];
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        if (Object.prototype.hasOwnProperty.call(row, 'tenant_id') && row.tenant_id !== tenant) {
          throw new ImportError(
            `Row in "${table}" has tenant_id="${row.tenant_id}" which does not match --tenant="${tenant}". ` +
              'Pass --all-tenants to import across tenants.',
          );
        }
      }
    }
  }

  const run = db.transaction(() => {
    if (remapIds) {
      importWithRemap(db, payload);
    } else {
      importPreservingIds(db, payload);
    }
  });

  run();
  return { remapIds: Boolean(remapIds) };
}

function importPreservingIds(db, payload) {
  let collisions = 0;
  const collidingTables = new Set();

  // Metadata tables (schema_meta) describe the target DB itself and already
  // exist there; never re-insert them.
  const metadata = new Set(METADATA_TABLES);

  for (const [table, rows] of Object.entries(payload)) {
    if (metadata.has(table)) continue;
    if (!Array.isArray(rows) || rows.length === 0) continue;
    const columns = Object.keys(rows[0]);
    // Whitelist the table and every column against the live schema before they
    // are interpolated into SQL — the keys come from attacker-controllable JSON.
    const { quotedTable, quotedColumns } = safeInsertIdentifiers(db, table, columns);
    const insert = db.prepare(
      `INSERT INTO ${quotedTable} (${quotedColumns.join(', ')}) VALUES (${columns
        .map(() => '?')
        .join(', ')})`,
    );
    for (const row of rows) {
      try {
        insert.run(...columns.map((c) => row[c]));
      } catch (err) {
        if (isConstraintError(err)) {
          collisions += 1;
          collidingTables.add(table);
        } else {
          throw err;
        }
      }
    }
  }

  if (collisions > 0) {
    throw new ImportError(
      `Import aborted: ${collisions} id/constraint collision(s) across ${[...collidingTables].join(', ')}. ` +
        'No rows were written. Re-run with --remap-ids to insert under fresh ids.',
    );
  }
}

function importWithRemap(db, payload) {
  // Insert every row under a fresh id, recording old→new id per table. FK
  // columns are inserted as-is first, then rewritten in a fixup pass once all
  // maps are known (handles forward and cyclic references uniformly).
  const idMaps = {}; // table -> Map(oldId -> newId)

  // Metadata tables (schema_meta) are singletons keyed on id=1; they are not
  // remapped and not re-inserted — the target DB already has its own.
  const importable = SCOPED_TABLES;

  for (const table of importable) {
    const rows = payload[table];
    if (!Array.isArray(rows) || rows.length === 0) continue;
    idMaps[table] = new Map();
    const insertColumns = Object.keys(rows[0]).filter((c) => c !== 'id');
    // `table` is a member of SCOPED_TABLES here, but the column names still come
    // from the payload; validate both against the live schema before interpolating.
    const { quotedTable, quotedColumns } = safeInsertIdentifiers(db, table, insertColumns);
    const insert = db.prepare(
      `INSERT INTO ${quotedTable} (${quotedColumns.join(', ')}) VALUES (${insertColumns
        .map(() => '?')
        .join(', ')})`,
    );
    for (const row of rows) {
      const info = insert.run(...insertColumns.map((c) => row[c]));
      const newId = Number(info.lastInsertRowid);
      if (row.id !== undefined && row.id !== null) {
        idMaps[table].set(row.id, newId);
      }
    }
  }

  // Fixup pass: rewrite FK columns to their remapped ids. We recompute the new
  // id from each row's (old id) position, matching the insert order above.
  for (const [table, fks] of Object.entries(FOREIGN_KEYS)) {
    const rows = payload[table];
    if (!Array.isArray(rows) || rows.length === 0) continue;
    const map = idMaps[table];
    if (!map) continue;

    for (const [column, parentTable] of Object.entries(fks)) {
      const parentMap = idMaps[parentTable];
      const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`);
      for (const row of rows) {
        const oldRef = row[column];
        if (oldRef === undefined || oldRef === null) continue;
        const newId = map.get(row.id);
        if (newId === undefined) continue;
        const newRef = parentMap ? parentMap.get(oldRef) : undefined;
        if (newRef === undefined) {
          // Reference to a row that was not part of this export. Null it out
          // rather than leaving a dangling id that points at unrelated data.
          update.run(null, newId);
        } else {
          update.run(newRef, newId);
        }
      }
    }
  }
}

function isConstraintError(err) {
  return (
    err &&
    typeof err.code === 'string' &&
    err.code.startsWith('SQLITE_CONSTRAINT')
  );
}

function main() {
  let parsed;
  try {
    parsed = parseImportArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    console.error(
      '\nUsage: node scripts/import-memory.mjs <db-path> <input-json> --tenant <id> [--remap-ids]',
    );
    console.error('       node scripts/import-memory.mjs <db-path> <input-json> --all-tenants [--remap-ids]');
    process.exit(1);
  }

  const { dbPath, inputPath, tenant, allTenants, remapIds } = parsed;
  if (!dbPath || !inputPath) {
    console.error('Usage: node scripts/import-memory.mjs <db-path> <input-json> --tenant <id>');
    process.exit(1);
  }

  const payload = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const db = new Database(dbPath);
  db.pragma('foreign_keys = OFF');
  try {
    importMemory(db, payload, { tenant, allTenants, remapIds });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  } finally {
    db.pragma('foreign_keys = ON');
    db.close();
  }
}

// Only run when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
