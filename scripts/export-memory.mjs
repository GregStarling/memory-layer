import fs from 'node:fs';
import Database from 'better-sqlite3';

const [, , dbPath, outputPath] = process.argv;

if (!dbPath || !outputPath) {
  console.error('Usage: node scripts/export-memory.mjs <db-path> <output-json>');
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });
const tables = [
  'turns',
  'working_memory',
  'knowledge_memory',
  'knowledge_memory_audit',
  'context_monitor',
  'compaction_log',
  'work_items',
  'schema_meta',
];

const payload = Object.fromEntries(
  tables.map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()]),
);

fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2));
db.close();
