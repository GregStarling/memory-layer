import type { MemoryScope } from '../contracts/identity.js';
import type { StorageAdapter } from '../contracts/storage.js';
import type {
  GraphReport,
  GraphReportOptions,
  GraphReportSection,
} from '../contracts/graph-report.js';
import { GRAPH_REPORT_DEFAULTS } from '../contracts/graph-report.js';
import { ValidationError } from '../contracts/errors.js';
import type { KnowledgeMemory } from '../contracts/types.js';
import { discover } from './discover.js';
import { lintKnowledge } from './knowledge-lint.js';
import { wrapSyncAdapter } from '../adapters/sync-to-async.js';
import { computeClusters, formatClustersAsSection } from './cluster.js';

const SECTION_LIMITS = {
  surprises: 5,
  issues: 5,
  highDegree: 10,
} as const;

const SECTION_NAMES = [
  'surprises',
  'issues',
  'high_degree',
  'gaps',
  'contradictions',
  'changes',
  'expiring',
  'clusters',
] as const;

/**
 * Produce a compact orientation artifact for system-prompt injection.
 *
 * Combines discover surprises, lint issues, high-degree knowledge facts,
 * knowledge gaps, active contradictions, recent changes, and soon-to-expire
 * temporal facts into structured markdown sections under a configurable
 * token budget (default 2000).
 */
export async function getGraphReport(
  adapter: StorageAdapter,
  scope: MemoryScope,
  options: GraphReportOptions = {},
): Promise<GraphReport> {
  const tokenBudget = options.tokenBudget ?? GRAPH_REPORT_DEFAULTS.tokenBudget;
  if (!Number.isFinite(tokenBudget) || tokenBudget <= 0) {
    throw new ValidationError("Memory validation: 'tokenBudget' must be a positive finite number");
  }
  const include = options.includeSections
    ? new Set(options.includeSections)
    : new Set<string>(SECTION_NAMES);

  let knowledge = adapter.getActiveKnowledgeMemory(scope);
  if (options.filterByTags && options.filterByTags.length > 0) {
    const tagFilter = options.filterByTags;
    knowledge = knowledge.filter((km) =>
      tagFilter.some((tag) => km.tags.includes(tag)),
    );
  }
  const knowledgeIds = new Set(knowledge.map((k) => k.id));
  const allAssociations = adapter.listAssociations(scope);
  // When tag-filtered, only include associations where both ends are in the filtered set
  const associations = options.filterByTags && options.filterByTags.length > 0
    ? allAssociations.filter((a) =>
        (a.source_kind !== 'knowledge' || knowledgeIds.has(a.source_id)) &&
        (a.target_kind !== 'knowledge' || knowledgeIds.has(a.target_id)),
      )
    : allAssociations;
  const now = Math.floor(Date.now() / 1000);

  const sections: GraphReportSection[] = [];

  // 1. Top 5 discover surprises
  if (include.has('surprises')) {
    // Request extra results to account for post-filtering by tags
    const discoverLimit = options.filterByTags?.length
      ? SECTION_LIMITS.surprises * 3
      : SECTION_LIMITS.surprises;
    let rawReport = await discover(adapter, scope, { maxResults: discoverLimit });
    // When tag-filtered, only keep surprises whose endpoints are in the filtered set
    if (options.filterByTags?.length) {
      rawReport = {
        ...rawReport,
        surprises: rawReport.surprises
          .filter((s) => {
            const srcId = parseKnowledgeNodeId(s.sourceId);
            const tgtId = parseKnowledgeNodeId(s.targetId);
            return (srcId == null || knowledgeIds.has(srcId)) && (tgtId == null || knowledgeIds.has(tgtId));
          })
          .slice(0, SECTION_LIMITS.surprises),
      };
    }
    const report = rawReport;
    if (report.surprises.length > 0) {
      const lines = report.surprises.map(
        (s, i) => `${i + 1}. **${s.bridgeType}** (score ${s.score.toFixed(2)}): ${s.explanation}`,
      );
      sections.push({
        title: 'Surprising Connections',
        content: lines.join('\n'),
        priority: 1,
      });
    }
  }

  // 2. Top 5 lint issues
  if (include.has('issues')) {
    const asyncAdapter = wrapSyncAdapter(adapter);
    const lintReport = await lintKnowledge(asyncAdapter, scope, {
      maxIssues: SECTION_LIMITS.issues,
      filterByTags: options.filterByTags,
    });
    if (lintReport.issues.length > 0) {
      const lines = lintReport.issues.map(
        (issue, i) => `${i + 1}. [${issue.severity}] **${issue.category}**: ${issue.message}`,
      );
      sections.push({
        title: 'Knowledge Issues',
        content: lines.join('\n'),
        priority: 2,
      });
    }
  }

  // 3. Top 10 high-degree knowledge facts
  if (include.has('high_degree')) {
    const degree = new Map<number, number>();
    for (const assoc of associations) {
      if (assoc.source_kind === 'knowledge') {
        degree.set(assoc.source_id, (degree.get(assoc.source_id) ?? 0) + 1);
      }
      if (assoc.target_kind === 'knowledge') {
        degree.set(assoc.target_id, (degree.get(assoc.target_id) ?? 0) + 1);
      }
    }

    const knowledgeById = new Map(knowledge.map((k) => [k.id, k]));
    const ranked = [...degree.entries()]
      .filter(([id]) => knowledgeById.has(id))
      .sort((a, b) => b[1] - a[1])
      .slice(0, SECTION_LIMITS.highDegree);

    if (ranked.length > 0) {
      const lines = ranked.map(([id, deg]) => {
        const k = knowledgeById.get(id)!;
        return `- **${truncate(k.fact, 80)}** (${deg} connections, ${k.knowledge_class})`;
      });
      sections.push({
        title: 'High-Degree Facts',
        content: lines.join('\n'),
        priority: 3,
      });
    }
  }

  // 4. Knowledge gaps — low-evidence trusted facts
  if (include.has('gaps')) {
    const gaps = knowledge
      .filter((k) => k.knowledge_state === 'trusted' && k.evidence_count <= 1)
      .sort((a, b) => a.trust_score - b.trust_score)
      .slice(0, 5);

    if (gaps.length > 0) {
      const lines = gaps.map(
        (k) => `- ${truncate(k.fact, 80)} (trust ${k.trust_score.toFixed(2)}, evidence: ${k.evidence_count})`,
      );
      sections.push({
        title: 'Knowledge Gaps',
        content: lines.join('\n'),
        priority: 4,
      });
    }
  }

  // 5. Active contradictions
  if (include.has('contradictions')) {
    const contradictions = associations.filter(
      (a) => a.association_type === 'contradicts' && a.source_kind === 'knowledge' && a.target_kind === 'knowledge',
    );
    const knowledgeById = new Map(knowledge.map((k) => [k.id, k]));

    if (contradictions.length > 0) {
      const lines = contradictions.slice(0, 5).map((a) => {
        const src = knowledgeById.get(a.source_id);
        const tgt = knowledgeById.get(a.target_id);
        const srcLabel = src ? truncate(src.fact, 50) : `knowledge:${a.source_id}`;
        const tgtLabel = tgt ? truncate(tgt.fact, 50) : `knowledge:${a.target_id}`;
        return `- "${srcLabel}" ↔ "${tgtLabel}"`;
      });
      sections.push({
        title: 'Active Contradictions',
        content: lines.join('\n'),
        priority: 5,
      });
    }
  }

  // 6. Recent changes (last 24h)
  if (include.has('changes')) {
    const oneDayAgo = now - 86_400;
    const recent = knowledge
      .filter((k) => k.created_at >= oneDayAgo)
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, 5);

    if (recent.length > 0) {
      const lines = recent.map(
        (k) => `- [${k.knowledge_state}] ${truncate(k.fact, 80)}`,
      );
      sections.push({
        title: 'Recent Changes',
        content: lines.join('\n'),
        priority: 6,
      });
    }
  }

  // 7. Soon-to-expire temporal facts (within 7 days)
  if (include.has('expiring')) {
    const sevenDaysOut = now + 7 * 86_400;
    const expiring = knowledge
      .filter((k): k is KnowledgeMemory & { valid_until: number } =>
        k.valid_until != null && k.valid_until > now && k.valid_until <= sevenDaysOut,
      )
      .sort((a, b) => a.valid_until - b.valid_until)
      .slice(0, 5);

    if (expiring.length > 0) {
      const lines = expiring.map((k) => {
        const daysLeft = Math.ceil((k.valid_until - now) / 86_400);
        return `- ${truncate(k.fact, 80)} (expires in ${daysLeft}d)`;
      });
      sections.push({
        title: 'Expiring Soon',
        content: lines.join('\n'),
        priority: 7,
      });
    }
  }

  // 8. Knowledge clusters (optional)
  if (include.has('clusters')) {
    const clusterResult = computeClusters(knowledge, associations);
    const clusterSection = formatClustersAsSection(clusterResult);
    if (clusterSection) {
      sections.push(clusterSection);
    }
  }

  // Enforce token budget by trimming sections from lowest priority
  const trimmed = enforceTokenBudget(sections, tokenBudget);

  const tokenEstimate = trimmed.reduce((sum, s) => sum + estimateTokens(s.content) + estimateTokens(s.title), 0);

  return {
    sections: trimmed,
    tokenEstimate,
    generatedAt: new Date().toISOString(),
  };
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

function parseKnowledgeNodeId(value: string): number | null {
  if (!value.startsWith('knowledge:')) return null;
  const rawId = value.slice('knowledge:'.length);
  if (!/^\d+$/.test(rawId)) return null;
  const parsed = Number(rawId);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function estimateTokens(text: string): number {
  // Rough estimate: ~4 chars per token
  return Math.ceil(text.length / 4);
}

function enforceTokenBudget(
  sections: GraphReportSection[],
  budget: number,
): GraphReportSection[] {
  // Sort by priority (lower = higher priority)
  const sorted = [...sections].sort((a, b) => a.priority - b.priority);
  const result: GraphReportSection[] = [];
  let used = 0;

  for (const section of sorted) {
    const cost = estimateTokens(section.content) + estimateTokens(section.title);
    if (used + cost <= budget) {
      result.push(section);
      used += cost;
    } else {
      // Try to fit a truncated version within the remaining budget
      const titleCost = estimateTokens(section.title);
      const remainingTokens = budget - used - titleCost;
      if (remainingTokens > 10) {
        const maxChars = remainingTokens * 4;
        const truncatedContent = section.content.slice(0, maxChars);
        const truncatedCost = estimateTokens(truncatedContent) + titleCost;
        if (used + truncatedCost <= budget) {
          result.push({ ...section, content: truncatedContent });
          used += truncatedCost;
        }
      }
      break;
    }
  }

  return result;
}
