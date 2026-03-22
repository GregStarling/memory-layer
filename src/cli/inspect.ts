import {
  createMemory,
  createMemoryWithAsyncAdapter,
  type CreateMemoryOptions,
} from '../core/quick.js';
import type { MemoryManager } from '../core/manager.js';
import type { MemoryScope, ScopeLevel } from '../contracts/identity.js';
import type {
  CompactionLog,
  ContextMonitor,
  KnowledgeEvidence,
  KnowledgeMemory,
  KnowledgeMemoryAudit,
  PaginatedResult,
} from '../contracts/types.js';
import { createSQLiteAdapterWithEmbeddings } from '../adapters/sqlite/index.js';
import { wrapSyncAdapter } from '../adapters/sync-to-async.js';

export interface InspectCliOptions {
  dbPath?: string;
  databaseUrl?: string;
  scope?: string;
  tenantId?: string;
  systemId?: string;
  workspaceId?: string;
  collaborationId?: string;
  scopeId?: string;
  qualityMode?: CreateMemoryOptions['qualityMode'];
  qualityTier?: CreateMemoryOptions['qualityTier'];
  crossScopeLevel?: ScopeLevel;
  limit?: number;
  cursor?: number;
  id?: number;
  knowledgeId?: number;
  since?: string;
  run?: boolean;
}

function resolveScope(options: InspectCliOptions): string | MemoryScope {
  if (options.tenantId && options.systemId && options.scopeId) {
    return {
      tenant_id: options.tenantId,
      system_id: options.systemId,
      workspace_id: options.workspaceId,
      collaboration_id: options.collaborationId,
      scope_id: options.scopeId,
    };
  }
  return options.scope ?? 'default';
}

async function createInspectionManager(options: InspectCliOptions): Promise<MemoryManager> {
  const scope = resolveScope(options);
  const baseOptions: CreateMemoryOptions = {
    adapter: 'sqlite',
    path: options.dbPath ?? ':memory:',
    scope,
    qualityMode: options.qualityMode,
    qualityTier: options.qualityTier,
    crossScopeLevel: options.crossScopeLevel,
  };
  if (options.databaseUrl) {
    const moduleName = 'pg';
    const pgModule = await import(moduleName).catch(() => {
      throw new Error(
        'memory-layer inspect: Postgres mode requires the "pg" package. Install it with: npm install pg',
      );
    });
    const { createPostgresAdapter } = await import('../adapters/postgres/index.js');
    const Pool = pgModule.Pool ?? pgModule.default?.Pool;
    const pool = new Pool({ connectionString: options.databaseUrl });
    return createMemoryWithAsyncAdapter({
      ...baseOptions,
      asyncAdapter: createPostgresAdapter(pool),
    });
  }
  const sqlite = createSQLiteAdapterWithEmbeddings(options.dbPath ?? ':memory:');
  return createMemoryWithAsyncAdapter({
    ...baseOptions,
    asyncAdapter: wrapSyncAdapter(sqlite),
    embeddingAdapter: sqlite.embeddings,
  });
}

function formatValue(value: unknown): string {
  if (value == null) return '-';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value);
}

function formatTable(headers: string[], rows: Array<Array<string | number | null | undefined>>): string {
  if (rows.length === 0) {
    return '(none)';
  }
  const stringRows = rows.map((row) => row.map((value) => formatValue(value)));
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...stringRows.map((row) => row[index]?.length ?? 0)),
  );
  const line = widths.map((width) => '-'.repeat(width)).join('-+-');
  const renderRow = (row: string[]) => row.map((value, index) => value.padEnd(widths[index])).join(' | ');
  return [renderRow(headers), line, ...stringRows.map(renderRow)].join('\n');
}

export function renderKnowledgeList(result: PaginatedResult<KnowledgeMemory>): string {
  const table = formatTable(
    ['ID', 'Type', 'State', 'Trust', 'Next Reverify', 'Fact'],
    result.items.map((item) => [
      item.id,
      item.fact_type,
      item.knowledge_state,
      item.trust_score,
      item.next_reverification_at,
      item.fact,
    ]),
  );
  const footer = `hasMore=${result.hasMore} nextCursor=${result.nextCursor ?? '-'}`;
  return `${table}\n${footer}`;
}

export function renderKnowledgeDetail(detail: {
  knowledge: KnowledgeMemory | null;
  evidence: KnowledgeEvidence[];
  audits: KnowledgeMemoryAudit[];
}): string {
  if (!detail.knowledge) {
    return 'Knowledge not found.';
  }
  const knowledge = detail.knowledge;
  const summary = [
    `Knowledge ${knowledge.id}`,
    `fact: ${knowledge.fact}`,
    `type: ${knowledge.fact_type}`,
    `state: ${knowledge.knowledge_state}`,
    `class: ${knowledge.knowledge_class}`,
    `trust_score: ${knowledge.trust_score}`,
    `verification_status: ${knowledge.verification_status}`,
    `next_reverification_at: ${formatValue(knowledge.next_reverification_at)}`,
  ].join('\n');
  const evidence = formatTable(
    ['ID', 'Source', 'Polarity', 'Outcome', 'Excerpt'],
    detail.evidence.map((item) => [
      item.id as number | undefined,
      item.source_type as string | undefined,
      item.support_polarity as string | undefined,
      item.outcome as string | undefined,
      item.excerpt as string | undefined,
    ]),
  );
  const audits = formatTable(
    ['ID', 'Decision', 'Created', 'Detail'],
    detail.audits.map((item) => [item.id, item.decision, item.created_at, item.detail]),
  );
  return `${summary}\n\nEvidence\n${evidence}\n\nAudits\n${audits}`;
}

export function renderAudits(audits: KnowledgeMemoryAudit[]): string {
  return formatTable(
    ['ID', 'Decision', 'Knowledge', 'Related', 'Created', 'Detail'],
    audits.map((item) => [
      item.id,
      item.decision,
      item.created_knowledge_id,
      item.related_knowledge_id,
      item.created_at,
      item.detail,
    ]),
  );
}

export function renderMonitor(monitor: ContextMonitor | null): string {
  if (!monitor) {
    return 'No context monitor found.';
  }
  return [
    `compaction_state: ${monitor.compaction_state}`,
    `active_turn_count: ${monitor.active_turn_count}`,
    `active_token_estimate: ${monitor.active_token_estimate}`,
    `compaction_score: ${monitor.compaction_score}`,
    `last_compaction_at: ${formatValue(monitor.last_compaction_at)}`,
    `updated_at: ${monitor.updated_at}`,
  ].join('\n');
}

export function renderCompactionLogs(logs: CompactionLog[]): string {
  return formatTable(
    ['ID', 'Trigger', 'Turns', 'Duration', 'Created'],
    logs.map((item) => [
      item.id,
      item.trigger_type,
      `${item.turn_id_start}-${item.turn_id_end}`,
      item.duration_ms,
      item.created_at,
    ]),
  );
}

export function renderDueReverification(items: KnowledgeMemory[]): string {
  return formatTable(
    ['ID', 'State', 'Trust', 'Next Reverify', 'Fact'],
    items.map((item) => [
      item.id,
      item.knowledge_state,
      item.trust_score,
      item.next_reverification_at,
      item.fact,
    ]),
  );
}

export async function runInspectCommand(
  target: 'knowledge' | 'audits' | 'monitor' | 'compactions' | 'reverification' | 'changes',
  options: InspectCliOptions,
): Promise<string> {
  const manager = await createInspectionManager(options);
  try {
    switch (target) {
      case 'knowledge':
        if (options.id != null) {
          return renderKnowledgeDetail(await manager.inspectKnowledge(options.id));
        }
        return renderKnowledgeList(
          await manager.listKnowledge({
            limit: options.limit,
            cursor: options.cursor,
          }),
        );
      case 'audits':
        return renderAudits(
          await manager.getKnowledgeAudits({
            knowledgeId: options.knowledgeId,
            limit: options.limit,
          }),
        );
      case 'monitor':
        return renderMonitor(await manager.getContextMonitor());
      case 'compactions':
        return renderCompactionLogs(await manager.getRecentCompactionLogs(options.limit));
      case 'reverification':
        if (options.run) {
          const result = await manager.runReverification({ limit: options.limit });
          return [
            `reverified=${result.reverifiedKnowledgeIds.length}`,
            `demoted=${result.demotedKnowledgeIds.length}`,
          ].join('\n');
        }
        return renderDueReverification(await manager.getDueReverification({ limit: options.limit }));
      case 'changes': {
        const since = options.since ? new Date(options.since) : new Date(0);
        if (Number.isNaN(since.valueOf())) {
          throw new Error('Invalid --since value');
        }
        return renderDueReverification(
          await manager.pollForChanges(since, {
            scopeLevel: options.crossScopeLevel,
          }),
        );
      }
      default:
        throw new Error(`Unsupported inspect target: ${target satisfies never}`);
    }
  } finally {
    await manager.close();
  }
}
