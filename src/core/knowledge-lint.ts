import type { AsyncStorageAdapter } from '../contracts/async-storage.js';
import type { MemoryScope } from '../contracts/identity.js';
import type { KnowledgeMemory } from '../contracts/types.js';
import type { LintOptions, LintReport, LintIssue, LintCategory } from '../contracts/lint.js';

const DEFAULT_MAX_ISSUES = 100;
const DEFAULT_MIN_ORPHAN_AGE_DAYS = 7;
const DEFAULT_STALE_PROVISIONAL_DAYS = 14;
const SECONDS_PER_DAY = 86_400;

function computeStats(knowledge: KnowledgeMemory[]): LintReport['stats'] {
  const byState: Record<string, number> = {};
  const byClass: Record<string, number> = {};
  let totalTrust = 0;
  let totalEvidence = 0;

  for (const k of knowledge) {
    byState[k.knowledge_state] = (byState[k.knowledge_state] ?? 0) + 1;
    byClass[k.knowledge_class] = (byClass[k.knowledge_class] ?? 0) + 1;
    totalTrust += k.trust_score;
    totalEvidence += k.evidence_count;
  }

  return {
    totalKnowledge: knowledge.length,
    byState,
    byClass,
    averageTrustScore: knowledge.length > 0 ? totalTrust / knowledge.length : 0,
    averageEvidenceCount: knowledge.length > 0 ? totalEvidence / knowledge.length : 0,
  };
}

function checkOrphanKnowledge(
  knowledge: KnowledgeMemory[],
  knowledgeIdsWithAssociations: Set<number>,
  minOrphanAgeDays: number,
): LintIssue[] {
  const issues: LintIssue[] = [];
  const now = Math.floor(Date.now() / 1000);
  const minAgeSeconds = minOrphanAgeDays * SECONDS_PER_DAY;

  for (const k of knowledge) {
    if (
      k.access_count === 0 &&
      !knowledgeIdsWithAssociations.has(k.id) &&
      now - k.created_at >= minAgeSeconds
    ) {
      issues.push({
        severity: 'warning',
        category: 'orphan_knowledge',
        message: `Knowledge #${k.id} has no associations and has never been accessed (age: ${Math.floor((now - k.created_at) / SECONDS_PER_DAY)}d)`,
        knowledgeIds: [k.id],
        details: { fact: k.fact, createdAt: k.created_at, accessCount: k.access_count },
      });
    }
  }

  return issues;
}

function checkEvidenceConcentration(knowledge: KnowledgeMemory[]): LintIssue[] {
  const issues: LintIssue[] = [];

  for (const k of knowledge) {
    if (k.evidence_count <= 1 && k.knowledge_state !== 'candidate') {
      issues.push({
        severity: 'info',
        category: 'evidence_concentration',
        message: `Knowledge #${k.id} has only ${k.evidence_count} evidence item(s) but is in '${k.knowledge_state}' state`,
        knowledgeIds: [k.id],
        details: { fact: k.fact, evidenceCount: k.evidence_count, state: k.knowledge_state },
      });
    }
  }

  return issues;
}

function checkTrustDistribution(knowledge: KnowledgeMemory[]): LintIssue[] {
  const issues: LintIssue[] = [];
  if (knowledge.length === 0) return issues;

  const total = knowledge.length;
  let provisionalAndCandidate = 0;
  let disputed = 0;

  for (const k of knowledge) {
    if (k.knowledge_state === 'provisional' || k.knowledge_state === 'candidate') {
      provisionalAndCandidate++;
    }
    if (k.knowledge_state === 'disputed') {
      disputed++;
    }
  }

  if (provisionalAndCandidate / total > 0.5) {
    const ids = knowledge
      .filter((k) => k.knowledge_state === 'provisional' || k.knowledge_state === 'candidate')
      .map((k) => k.id);
    issues.push({
      severity: 'warning',
      category: 'trust_distribution',
      message: `${provisionalAndCandidate} of ${total} knowledge items (${Math.round((provisionalAndCandidate / total) * 100)}%) are provisional or candidate`,
      knowledgeIds: ids,
      details: { provisionalAndCandidate, total, percentage: provisionalAndCandidate / total },
    });
  }

  if (disputed / total > 0.1) {
    const ids = knowledge
      .filter((k) => k.knowledge_state === 'disputed')
      .map((k) => k.id);
    issues.push({
      severity: 'error',
      category: 'trust_distribution',
      message: `${disputed} of ${total} knowledge items (${Math.round((disputed / total) * 100)}%) are disputed`,
      knowledgeIds: ids,
      details: { disputed, total, percentage: disputed / total },
    });
  }

  return issues;
}

function checkContradictionClusters(
  knowledge: KnowledgeMemory[],
  contradictionEdges: Array<{ sourceId: number; targetId: number }>,
): LintIssue[] {
  const issues: LintIssue[] = [];
  if (contradictionEdges.length === 0) return issues;

  // Build adjacency list for contradiction graph
  const knowledgeIdSet = new Set(knowledge.map((k) => k.id));
  const adjacency = new Map<number, Set<number>>();

  for (const edge of contradictionEdges) {
    if (!knowledgeIdSet.has(edge.sourceId) || !knowledgeIdSet.has(edge.targetId)) continue;
    if (!adjacency.has(edge.sourceId)) adjacency.set(edge.sourceId, new Set());
    if (!adjacency.has(edge.targetId)) adjacency.set(edge.targetId, new Set());
    adjacency.get(edge.sourceId)!.add(edge.targetId);
    adjacency.get(edge.targetId)!.add(edge.sourceId);
  }

  // Find connected components via BFS
  const visited = new Set<number>();
  for (const nodeId of adjacency.keys()) {
    if (visited.has(nodeId)) continue;
    const cluster: number[] = [];
    const queue = [nodeId];
    while (queue.length > 0) {
      const current = queue.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      cluster.push(current);
      for (const neighbor of adjacency.get(current) ?? []) {
        if (!visited.has(neighbor)) queue.push(neighbor);
      }
    }
    if (cluster.length >= 2) {
      issues.push({
        severity: 'warning',
        category: 'contradiction_cluster',
        message: `Contradiction cluster with ${cluster.length} knowledge items: [${cluster.join(', ')}]`,
        knowledgeIds: cluster,
        details: { clusterSize: cluster.length },
      });
    }
  }

  return issues;
}

function checkStaleProvisional(knowledge: KnowledgeMemory[]): LintIssue[] {
  const issues: LintIssue[] = [];
  const now = Math.floor(Date.now() / 1000);
  const staleThreshold = DEFAULT_STALE_PROVISIONAL_DAYS * SECONDS_PER_DAY;

  for (const k of knowledge) {
    if (k.knowledge_state === 'provisional' && now - k.created_at >= staleThreshold) {
      issues.push({
        severity: 'warning',
        category: 'stale_provisional',
        message: `Knowledge #${k.id} has been provisional for ${Math.floor((now - k.created_at) / SECONDS_PER_DAY)} days`,
        knowledgeIds: [k.id],
        details: { fact: k.fact, createdAt: k.created_at, ageDays: Math.floor((now - k.created_at) / SECONDS_PER_DAY) },
      });
    }
  }

  return issues;
}

function buildSummary(issues: LintIssue[]): LintReport['summary'] {
  const bySeverity: Record<'info' | 'warning' | 'error', number> = { info: 0, warning: 0, error: 0 };
  const byCategory: Record<string, number> = {};

  for (const issue of issues) {
    bySeverity[issue.severity]++;
    byCategory[issue.category] = (byCategory[issue.category] ?? 0) + 1;
  }

  return {
    totalIssues: issues.length,
    bySeverity,
    byCategory,
  };
}

export async function lintKnowledge(
  adapter: AsyncStorageAdapter,
  scope: MemoryScope,
  options?: LintOptions,
): Promise<LintReport> {
  const maxIssues = options?.maxIssues ?? DEFAULT_MAX_ISSUES;
  const minOrphanAgeDays = options?.minOrphanAgeDays ?? DEFAULT_MIN_ORPHAN_AGE_DAYS;
  const categories = options?.categories;

  const shouldRun = (cat: LintCategory) => !categories || categories.includes(cat);

  // Fetch all active knowledge
  const knowledge = await adapter.getActiveKnowledgeMemory(scope);
  const stats = computeStats(knowledge);

  let allIssues: LintIssue[] = [];

  // Orphan knowledge check
  if (shouldRun('orphan_knowledge') || shouldRun('contradiction_cluster')) {
    // We need associations for both orphan and contradiction checks
    const associations = await adapter.listAssociations(scope);

    if (shouldRun('orphan_knowledge')) {
      const knowledgeIdsWithAssociations = new Set<number>();
      for (const assoc of associations) {
        if (assoc.source_kind === 'knowledge') knowledgeIdsWithAssociations.add(assoc.source_id);
        if (assoc.target_kind === 'knowledge') knowledgeIdsWithAssociations.add(assoc.target_id);
      }
      allIssues.push(...checkOrphanKnowledge(knowledge, knowledgeIdsWithAssociations, minOrphanAgeDays));
    }

    if (shouldRun('contradiction_cluster')) {
      const contradictionEdges = associations
        .filter((a) => a.association_type === 'contradicts' && a.source_kind === 'knowledge' && a.target_kind === 'knowledge')
        .map((a) => ({ sourceId: a.source_id, targetId: a.target_id }));
      allIssues.push(...checkContradictionClusters(knowledge, contradictionEdges));
    }
  }

  if (shouldRun('evidence_concentration')) {
    allIssues.push(...checkEvidenceConcentration(knowledge));
  }

  if (shouldRun('trust_distribution')) {
    allIssues.push(...checkTrustDistribution(knowledge));
  }

  if (shouldRun('stale_provisional')) {
    allIssues.push(...checkStaleProvisional(knowledge));
  }

  // Apply category filter (in case we fetched associations for contradictions but not orphans)
  if (categories) {
    allIssues = allIssues.filter((issue) => categories.includes(issue.category));
  }

  // Truncate to maxIssues
  if (allIssues.length > maxIssues) {
    allIssues = allIssues.slice(0, maxIssues);
  }

  return {
    issues: allIssues,
    summary: buildSummary(allIssues),
    stats,
    generatedAt: Math.floor(Date.now() / 1000),
  };
}
