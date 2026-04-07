export type LintCategory =
  | 'orphan_knowledge'
  | 'evidence_concentration'
  | 'trust_distribution'
  | 'contradiction_cluster'
  | 'stale_provisional';

export interface LintIssue {
  severity: 'info' | 'warning' | 'error';
  category: LintCategory;
  message: string;
  knowledgeIds?: number[];
  details?: Record<string, unknown>;
}

export interface LintReport {
  issues: LintIssue[];
  summary: {
    totalIssues: number;
    bySeverity: Record<'info' | 'warning' | 'error', number>;
    byCategory: Record<string, number>;
  };
  stats: {
    totalKnowledge: number;
    byState: Record<string, number>;
    byClass: Record<string, number>;
    averageTrustScore: number;
    averageEvidenceCount: number;
  };
  generatedAt: number;
}

export interface LintOptions {
  categories?: LintCategory[];
  maxIssues?: number;
  minOrphanAgeDays?: number;
}
