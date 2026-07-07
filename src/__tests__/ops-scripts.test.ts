import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { createSQLiteSchema } from '../adapters/sqlite/schema.js';

// The ops scripts are plain .mjs modules; import them by URL so we exercise the
// real code paths the CLI uses.
const exportMod = await import(
  new URL('../../scripts/export-memory.mjs', import.meta.url).href
);
const importMod = await import(
  new URL('../../scripts/import-memory.mjs', import.meta.url).href
);

const { parseExportArgs, exportMemory, SCOPED_TABLES } = exportMod;
const { parseImportArgs, importMemory } = importMod;

const nowTs = 1_700_000_000;

/** Insert one playbook for a tenant; returns the new id. */
function insertPlaybook(db: Database.Database, tenant: string, title: string): number {
  const info = db
    .prepare(
      `INSERT INTO playbooks
        (tenant_id, system_id, workspace_id, collaboration_id, scope_id, title, description, instructions, created_at, updated_at)
       VALUES (@tenant_id, @system_id, @workspace_id, @collaboration_id, @scope_id, @title, @description, @instructions, @created_at, @updated_at)`,
    )
    .run({
      tenant_id: tenant,
      system_id: 'sys',
      workspace_id: 'default',
      collaboration_id: '',
      scope_id: 'scope',
      title,
      description: 'desc',
      instructions: 'do the thing',
      created_at: nowTs,
      updated_at: nowTs,
    });
  return Number(info.lastInsertRowid);
}

/** Insert one association row (self-contained polymorphic reference) for a tenant. */
function insertAssociation(db: Database.Database, tenant: string, type: string): number {
  const info = db
    .prepare(
      `INSERT INTO associations
        (tenant_id, system_id, workspace_id, collaboration_id, scope_id, source_kind, source_id, target_kind, target_id, association_type, created_at)
       VALUES (@tenant_id, @system_id, @workspace_id, @collaboration_id, @scope_id, @source_kind, @source_id, @target_kind, @target_id, @association_type, @created_at)`,
    )
    .run({
      tenant_id: tenant,
      system_id: 'sys',
      workspace_id: 'default',
      collaboration_id: '',
      scope_id: 'scope',
      source_kind: 'knowledge',
      source_id: 1,
      target_kind: 'knowledge',
      target_id: 2,
      association_type: type,
      created_at: nowTs,
    });
  return Number(info.lastInsertRowid);
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ops-scripts-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function freshDb(): Database.Database {
  const db = new Database(join(dir, `db-${Math.random().toString(36).slice(2)}.sqlite`));
  createSQLiteSchema(db);
  return db;
}

const now = 1_700_000_000;

/** Insert one turn for a tenant; returns the new id. */
function insertTurn(db: Database.Database, tenant: string, content: string): number {
  const info = db
    .prepare(
      `INSERT INTO turns (session_id, tenant_id, system_id, workspace_id, collaboration_id, scope_id, actor, role, content, token_estimate, created_at)
       VALUES (@session_id, @tenant_id, @system_id, @workspace_id, @collaboration_id, @scope_id, @actor, @role, @content, @token_estimate, @created_at)`,
    )
    .run({
      session_id: `sess-${tenant}`,
      tenant_id: tenant,
      system_id: 'sys',
      workspace_id: 'default',
      collaboration_id: '',
      scope_id: 'scope',
      actor: 'tester',
      role: 'user',
      content,
      token_estimate: 4,
      created_at: now,
    });
  return Number(info.lastInsertRowid);
}

/** Insert one knowledge_memory row for a tenant; returns the new id. `fact` is the payload. */
function insertKnowledge(db: Database.Database, tenant: string, fact: string): number {
  const info = db
    .prepare(
      `INSERT INTO knowledge_memory
        (tenant_id, system_id, workspace_id, collaboration_id, scope_id, fact, fact_type, source, slot_key, trust_score, created_at, last_accessed_at)
       VALUES (@tenant_id, @system_id, @workspace_id, @collaboration_id, @scope_id, @fact, @fact_type, @source, @slot_key, @trust_score, @created_at, @last_accessed_at)`,
    )
    .run({
      tenant_id: tenant,
      system_id: 'sys',
      workspace_id: 'default',
      collaboration_id: '',
      scope_id: 'scope',
      fact,
      fact_type: 'preference',
      source: 'test',
      slot_key: `slot-${fact}`,
      trust_score: 0.9,
      created_at: now,
      last_accessed_at: now,
    });
  return Number(info.lastInsertRowid);
}

/** Insert one knowledge_evidence row linked to a knowledge_memory id. */
function insertEvidence(
  db: Database.Database,
  tenant: string,
  knowledgeId: number,
  excerpt: string,
): number {
  const info = db
    .prepare(
      `INSERT INTO knowledge_evidence
        (tenant_id, system_id, workspace_id, collaboration_id, scope_id, knowledge_memory_id, source_type, support_polarity, excerpt, created_at)
       VALUES (@tenant_id, @system_id, @workspace_id, @collaboration_id, @scope_id, @knowledge_memory_id, @source_type, @support_polarity, @excerpt, @created_at)`,
    )
    .run({
      tenant_id: tenant,
      system_id: 'sys',
      workspace_id: 'default',
      collaboration_id: '',
      scope_id: 'scope',
      knowledge_memory_id: knowledgeId,
      source_type: 'turn',
      support_polarity: 'supports',
      excerpt,
      created_at: now,
    });
  return Number(info.lastInsertRowid);
}

describe('export-memory arg parsing', () => {
  it('refuses to export without --tenant or --all-tenants', () => {
    expect(() => parseExportArgs(['db.sqlite', 'out.json'])).toThrow(/--tenant|--all-tenants/);
  });

  it('parses tenant + optional scope flags', () => {
    const parsed = parseExportArgs([
      'db.sqlite',
      'out.json',
      '--tenant',
      'A',
      '--system',
      'sys',
    ]);
    expect(parsed.scope).toEqual({ tenant_id: 'A', system_id: 'sys' });
    expect(parsed.allTenants).toBe(false);
  });

  it('accepts --all-tenants without a tenant', () => {
    const parsed = parseExportArgs(['db.sqlite', 'out.json', '--all-tenants']);
    expect(parsed.allTenants).toBe(true);
  });
});

describe('scoped export', () => {
  it('export scoped to tenant A contains zero tenant-B rows across every table', () => {
    const db = freshDb();
    // Seed both tenants across a representative set of scoped tables.
    insertTurn(db, 'A', 'a-turn');
    insertTurn(db, 'B', 'b-turn');
    const kA = insertKnowledge(db, 'A', 'a-fact');
    const kB = insertKnowledge(db, 'B', 'b-fact');
    insertEvidence(db, 'A', kA, 'a-evidence');
    insertEvidence(db, 'B', kB, 'b-evidence');

    const payload = exportMemory(db, { scope: { tenant_id: 'A' }, allTenants: false });
    db.close();

    for (const table of SCOPED_TABLES) {
      const rows = payload[table] as Array<{ tenant_id?: string }>;
      for (const row of rows) {
        expect(row.tenant_id).toBe('A');
      }
    }
    // And it actually captured tenant A's data (not just an empty result).
    expect((payload.turns as unknown[]).length).toBe(1);
    expect((payload.knowledge_memory as unknown[]).length).toBe(1);
    expect((payload.knowledge_evidence as unknown[]).length).toBe(1);
  });

  it('--all-tenants exports every tenant', () => {
    const db = freshDb();
    insertTurn(db, 'A', 'a-turn');
    insertTurn(db, 'B', 'b-turn');
    const payload = exportMemory(db, { scope: {}, allTenants: true });
    db.close();
    expect((payload.turns as unknown[]).length).toBe(2);
  });
});

describe('import-memory arg parsing', () => {
  it('refuses to import without --tenant or --all-tenants', () => {
    expect(() => parseImportArgs(['db.sqlite', 'in.json'])).toThrow(/--tenant|--all-tenants/);
  });

  it('parses --remap-ids and --tenant', () => {
    const parsed = parseImportArgs(['db.sqlite', 'in.json', '--tenant', 'A', '--remap-ids']);
    expect(parsed.tenant).toBe('A');
    expect(parsed.remapIds).toBe(true);
  });
});

describe('import collision safety', () => {
  it('import with a colliding id exits non-zero (throws) and writes nothing', () => {
    // Source export from tenant A.
    const src = freshDb();
    insertTurn(src, 'A', 'a-turn');
    const kA = insertKnowledge(src, 'A', 'a-fact');
    insertEvidence(src, 'A', kA, 'a-evidence');
    const payload = exportMemory(src, { scope: { tenant_id: 'A' }, allTenants: false });
    src.close();

    // Target DB that already holds a row at the same ids (id=1 for turns etc.).
    const target = freshDb();
    insertTurn(target, 'A', 'existing-turn');
    insertKnowledge(target, 'A', 'existing-fact');
    const beforeTurns = target.prepare('SELECT COUNT(*) AS n FROM turns').get() as { n: number };
    const beforeKnowledge = target
      .prepare('SELECT COUNT(*) AS n FROM knowledge_memory')
      .get() as { n: number };

    expect(() =>
      importMemory(target, payload, { tenant: 'A', allTenants: false, remapIds: false }),
    ).toThrow(/collision/i);

    // No partial write: counts unchanged (whole import was one transaction).
    const afterTurns = target.prepare('SELECT COUNT(*) AS n FROM turns').get() as { n: number };
    const afterKnowledge = target
      .prepare('SELECT COUNT(*) AS n FROM knowledge_memory')
      .get() as { n: number };
    expect(afterTurns.n).toBe(beforeTurns.n);
    expect(afterKnowledge.n).toBe(beforeKnowledge.n);
    target.close();
  });

  it('refuses rows whose tenant_id does not match --tenant', () => {
    const src = freshDb();
    insertTurn(src, 'B', 'b-turn');
    const payload = exportMemory(src, { scope: { tenant_id: 'B' }, allTenants: false });
    src.close();

    const target = freshDb();
    expect(() =>
      importMemory(target, payload, { tenant: 'A', allTenants: false, remapIds: false }),
    ).toThrow(/tenant_id/i);
    const n = target.prepare('SELECT COUNT(*) AS n FROM turns').get() as { n: number };
    expect(n.n).toBe(0);
    target.close();
  });
});

describe('remap-ids preserves internal linkage', () => {
  it('--remap-ids import preserves evidence->knowledge linkage under new ids', () => {
    // Source: a knowledge fact with an evidence row pointing at it.
    const src = freshDb();
    const kId = insertKnowledge(src, 'A', 'linked-fact');
    insertEvidence(src, 'A', kId, 'linked-evidence');
    const payload = exportMemory(src, { scope: { tenant_id: 'A' }, allTenants: false });
    src.close();

    // Target already has knowledge + evidence occupying id=1, so a plain import
    // would collide. --remap-ids must insert under fresh ids AND rewrite the FK.
    const target = freshDb();
    insertKnowledge(target, 'A', 'preexisting-fact');
    insertEvidence(target, 'A', 1, 'preexisting-evidence');

    importMemory(target, payload, { tenant: 'A', allTenants: false, remapIds: true });

    // The imported evidence excerpt must resolve to the imported knowledge fact.
    const evidence = target
      .prepare('SELECT knowledge_memory_id FROM knowledge_evidence WHERE excerpt = ?')
      .get('linked-evidence') as { knowledge_memory_id: number } | undefined;
    expect(evidence).toBeDefined();

    const linkedFact = target
      .prepare('SELECT fact FROM knowledge_memory WHERE id = ?')
      .get(evidence!.knowledge_memory_id) as { fact: string } | undefined;
    expect(linkedFact?.fact).toBe('linked-fact');

    // And the linkage did not accidentally point at the preexisting fact.
    expect(evidence!.knowledge_memory_id).not.toBe(1);
    target.close();
  });
});

describe('finding 6 — export covers all tenant-scoped tables', () => {
  it('SCOPED_TABLES includes playbooks and associations', () => {
    // These were dropped by the original list; a scoped backup silently lost them.
    expect(SCOPED_TABLES).toContain('playbooks');
    expect(SCOPED_TABLES).toContain('associations');
  });

  it('every table in SCOPED_TABLES actually has a tenant_id column', () => {
    const db = freshDb();
    for (const table of SCOPED_TABLES) {
      const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (r) => r.name,
      );
      expect(cols, `table ${table} must have tenant_id to be scope-filterable`).toContain(
        'tenant_id',
      );
    }
    db.close();
  });

  it('scoped export preserves playbooks/associations and leaks zero tenant-B rows', () => {
    const db = freshDb();
    insertPlaybook(db, 'A', 'a-playbook');
    insertPlaybook(db, 'B', 'b-playbook');
    insertAssociation(db, 'A', 'a-assoc');
    insertAssociation(db, 'B', 'b-assoc');

    const payload = exportMemory(db, { scope: { tenant_id: 'A' }, allTenants: false });
    db.close();

    // Captured tenant A's rows...
    expect((payload.playbooks as unknown[]).length).toBe(1);
    expect((payload.associations as unknown[]).length).toBe(1);
    // ...and never any tenant-B rows, across EVERY exported scoped table.
    for (const table of SCOPED_TABLES) {
      for (const row of payload[table] as Array<{ tenant_id?: string }>) {
        expect(row.tenant_id).toBe('A');
      }
    }
  });

  it('round-trips playbooks and associations through export -> --remap-ids import', () => {
    const src = freshDb();
    insertPlaybook(src, 'A', 'roundtrip-playbook');
    insertAssociation(src, 'A', 'roundtrip-assoc');
    const payload = exportMemory(src, { scope: { tenant_id: 'A' }, allTenants: false });
    src.close();

    // Target already occupies id=1 in both tables, forcing a remap.
    const target = freshDb();
    insertPlaybook(target, 'A', 'preexisting-playbook');
    insertAssociation(target, 'A', 'preexisting-assoc');

    importMemory(target, payload, { tenant: 'A', allTenants: false, remapIds: true });

    const pb = target
      .prepare('SELECT title FROM playbooks WHERE title = ?')
      .get('roundtrip-playbook') as { title: string } | undefined;
    expect(pb?.title).toBe('roundtrip-playbook');

    const assoc = target
      .prepare('SELECT association_type FROM associations WHERE association_type = ?')
      .get('roundtrip-assoc') as { association_type: string } | undefined;
    expect(assoc?.association_type).toBe('roundtrip-assoc');
    target.close();
  });
});

describe('finding 4 — import rejects non-whitelisted / cross-tenant tables', () => {
  it('refuses a payload naming a table outside the allow-list', () => {
    const target = freshDb();
    // `sqlite_master` is a real table but not importable; a hostile export could
    // just as easily name any tenant-scoped table absent from the allow-list.
    const payload = { not_a_real_import_table: [{ id: 1, tenant_id: 'A' }] };
    expect(() =>
      importMemory(target, payload as never, { tenant: 'A', allTenants: false, remapIds: false }),
    ).toThrow(/unknown table/i);
    target.close();
  });

  it('refuses a tenant-scoped table (playbooks) whose rows belong to another tenant', () => {
    // Pre-fix, the tenant-match check ran only over the core SCOPED_TABLES, so a
    // crafted playbooks payload under tenant B slipped past --tenant A.
    const src = freshDb();
    insertPlaybook(src, 'B', 'b-playbook');
    const payload = exportMemory(src, { scope: { tenant_id: 'B' }, allTenants: false });
    src.close();

    const target = freshDb();
    expect(() =>
      importMemory(target, payload, { tenant: 'A', allTenants: false, remapIds: false }),
    ).toThrow(/tenant_id/i);
    const n = target.prepare('SELECT COUNT(*) AS n FROM playbooks').get() as { n: number };
    expect(n.n).toBe(0);
    target.close();
  });
});

describe('finding 5 — import rejects SQL identifier injection via JSON keys', () => {
  it('refuses a payload whose column key is not a real column', () => {
    const target = freshDb();
    // A crafted row key that, unvalidated, would be interpolated straight into
    // the INSERT column list. Must be rejected before any SQL is built.
    const payload = {
      turns: [
        {
          tenant_id: 'A',
          'content) VALUES (1); DROP TABLE turns; --': 'x',
        },
      ],
    };
    expect(() =>
      importMemory(target, payload as never, { tenant: 'A', allTenants: false, remapIds: false }),
    ).toThrow(/does not exist/i);
    // The turns table is still intact (the injection never executed).
    const n = target.prepare('SELECT COUNT(*) AS n FROM turns').get() as { n: number };
    expect(n.n).toBe(0);
    target.close();
  });

  it('refuses the same injection attempt under --remap-ids', () => {
    const target = freshDb();
    const payload = {
      knowledge_memory: [
        {
          id: 1,
          tenant_id: 'A',
          'fact) VALUES ("pwned"); --': 'x',
        },
      ],
    };
    expect(() =>
      importMemory(target, payload as never, { tenant: 'A', allTenants: false, remapIds: true }),
    ).toThrow(/does not exist/i);
    const n = target.prepare('SELECT COUNT(*) AS n FROM knowledge_memory').get() as { n: number };
    expect(n.n).toBe(0);
    target.close();
  });
});
