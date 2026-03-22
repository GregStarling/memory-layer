import fs from 'node:fs';
import Database from 'better-sqlite3';

const [, , dbPath, inputPath] = process.argv;

if (!dbPath || !inputPath) {
  console.error('Usage: node scripts/import-memory.mjs <db-path> <input-json>');
  process.exit(1);
}

const payload = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const db = new Database(dbPath);

db.exec('PRAGMA foreign_keys = OFF');
const transaction = db.transaction(() => {
  for (const [table, rows] of Object.entries(payload)) {
    if (!Array.isArray(rows) || rows.length === 0) continue;
    const columns = Object.keys(rows[0]);
    const placeholders = columns.map(() => '?').join(', ');
    const insert = db.prepare(
      `INSERT OR REPLACE INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`,
    );
    for (const row of rows) {
      insert.run(...columns.map((column) => row[column]));
    }
  }
});

transaction();
db.exec('PRAGMA foreign_keys = ON');
db.close();
