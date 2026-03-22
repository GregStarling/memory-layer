import type { KnowledgeClass } from './types.js';

export type ConflictStrategy = 'supersede' | 'keep_both' | 'skip';
export type ContextMode = 'chat' | 'coding' | 'autonomous_agent' | 'review';

export interface MonitorPatterns {
  subjectChange: RegExp[];
  taskReset: RegExp[];
  acknowledgment: RegExp[];
  close: RegExp[];
}

export interface MaintenancePolicy {
  workingMemoryTtlSeconds?: number;
  completedWorkItemTtlSeconds?: number;
  knowledgeStaleAfterSeconds?: number;
  minKnowledgeAccessCount?: number;
  maxActiveKnowledgeItems?: number;
  consolidateKnowledge?: boolean;
  trustedCoreRetentionDays?: number;
  provisionalRetentionDays?: number;
  disputedRetentionDays?: number;
  reverificationCadenceDays?: number;
  classRetentionOverrides?: Partial<Record<
    | 'identity'
    | 'preference'
    | 'constraint'
    | 'procedure'
    | 'strategy'
    | 'anti_pattern'
    | 'project_fact'
    | 'episodic_fact',
    number
  >>;
  requireReconfirmationForProjectFacts?: boolean;
  preserveEvidenceForTrustedKnowledge?: boolean;
}

export interface MonitorPolicy {
  softTurnThreshold?: number;
  hardTurnThreshold?: number;
  softTokenThreshold?: number;
  hardTokenThreshold?: number;
  softRetainTurns?: number;
  hardRetainTurns?: number;
  softScoreThreshold?: number;
  hardScoreThreshold?: number;
  floorTurns?: number;
  floorTokens?: number;
  recentWindow?: number;
  toolLookBack?: number;
  heavySingleTokenSoft?: number;
  heavySingleTokenHard?: number;
  heavyCumulativeTokens?: number;
  intraSessionGapSeconds?: number;
  customPatterns?: Partial<MonitorPatterns>;
}

export interface ExtractionPolicy {
  autoExtractAfterCompaction?: boolean;
  maxFactsPerExtraction?: number;
  deduplicateFacts?: boolean;
  touchDuplicates?: boolean;
  minConfidenceForPromotion?: 'high' | 'medium';
  conflictStrategy?: ConflictStrategy;
  requireGroundingForTrusted?: boolean;
  minimumEvidenceCountForTrusted?: number;
  assistantClaimPenalty?: number;
  toolEvidenceBoost?: number;
  explicitStatementBoost?: number;
  contradictionDisputeThreshold?: number;
  trustPromotionThreshold?: number;
  trustProvisionalThreshold?: number;
  humanFeedbackBoost?: number;
  executionSuccessBoost?: number;
  executionFailurePenalty?: number;
  noGroundingPenalty?: number;
  contradictionTrustPenalty?: number;
  reverificationExplicitnessBoost?: number;
  reverificationContradictionPenalty?: number;
  contradictionSeverityMediumThreshold?: number;
  contradictionSeverityHighThreshold?: number;
}

export interface ContextPolicy {
  mode?: ContextMode;
  maxKnowledgeItems?: number;
  maxRecentSummaries?: number;
  tokenBudget?: number;
  lexicalWeight?: number;
  semanticWeight?: number;
  recencyWeight?: number;
  importanceWeight?: number;
  trustWeight?: number;
  durabilityWeight?: number;
  evidenceWeight?: number;
  contradictionPenalty?: number;
  provisionalPenalty?: number;
  objectiveLinkWeight?: number;
  scopeRelationWeight?: number;
  collaborationScopeScore?: number;
  systemScopeScore?: number;
  tenantScopeScore?: number;
  localTrustedBonus?: number;
  localTrustedThreshold?: number;
  lineageWeight?: number;
  unrelatedLineagePenalty?: number;
  minimumLineageScore?: number;
  evidenceSaturationCount?: number;
  classImportanceOverrides?: Partial<Record<KnowledgeClass, number>>;
  semanticMinSimilarity?: number;
  trustedCoreLimit?: number;
  taskRelevantLimit?: number;
  diversityPenalty?: number;
  maxPerFactType?: number;
  touchSelectedKnowledge?: boolean;
}

export const DEFAULT_MONITOR_POLICY: Required<Omit<MonitorPolicy, 'customPatterns'>> & {
  customPatterns: Required<MonitorPatterns>;
} = {
  softTurnThreshold: 15,
  hardTurnThreshold: 30,
  softTokenThreshold: 3000,
  hardTokenThreshold: 6000,
  softRetainTurns: 12,
  hardRetainTurns: 8,
  softScoreThreshold: 4,
  hardScoreThreshold: 6,
  floorTurns: 15,
  floorTokens: 3000,
  recentWindow: 10,
  toolLookBack: 5,
  heavySingleTokenSoft: 600,
  heavySingleTokenHard: 1200,
  heavyCumulativeTokens: 2400,
  intraSessionGapSeconds: 1800,
  customPatterns: {
    subjectChange: [],
    taskReset: [],
    acknowledgment: [],
    close: [],
  },
};

export const DEFAULT_EXTRACTION_POLICY: Required<ExtractionPolicy> = {
  autoExtractAfterCompaction: true,
  maxFactsPerExtraction: 10,
  deduplicateFacts: true,
  touchDuplicates: true,
  minConfidenceForPromotion: 'medium',
  conflictStrategy: 'supersede',
  requireGroundingForTrusted: true,
  minimumEvidenceCountForTrusted: 2,
  assistantClaimPenalty: 0.15,
  toolEvidenceBoost: 0.2,
  explicitStatementBoost: 0.1,
  contradictionDisputeThreshold: 0.35,
  trustPromotionThreshold: 0.7,
  trustProvisionalThreshold: 0.45,
  humanFeedbackBoost: 0.2,
  executionSuccessBoost: 0.15,
  executionFailurePenalty: 0.2,
  noGroundingPenalty: 0.35,
  contradictionTrustPenalty: 0.5,
  reverificationExplicitnessBoost: 0.1,
  reverificationContradictionPenalty: 0.25,
  contradictionSeverityMediumThreshold: 0.35,
  contradictionSeverityHighThreshold: 0.75,
};

export const DEFAULT_CONTEXT_POLICY: Required<ContextPolicy> = {
  maxKnowledgeItems: 20,
  maxRecentSummaries: 3,
  mode: 'chat',
  tokenBudget: Number.MAX_SAFE_INTEGER,
  lexicalWeight: 1,
  semanticWeight: 1.2,
  recencyWeight: 1,
  importanceWeight: 0.25,
  trustWeight: 1.3,
  durabilityWeight: 0.8,
  evidenceWeight: 0.5,
  contradictionPenalty: 1.5,
  provisionalPenalty: 0.75,
  objectiveLinkWeight: 0.4,
  scopeRelationWeight: 0.25,
  collaborationScopeScore: 0.65,
  systemScopeScore: 0.3,
  tenantScopeScore: 0.1,
  localTrustedBonus: 0.35,
  localTrustedThreshold: 0.7,
  lineageWeight: 0.3,
  unrelatedLineagePenalty: 0.35,
  minimumLineageScore: 0.5,
  evidenceSaturationCount: 3,
  classImportanceOverrides: {},
  semanticMinSimilarity: 0.1,
  trustedCoreLimit: 8,
  taskRelevantLimit: 12,
  diversityPenalty: 0.2,
  maxPerFactType: 8,
  touchSelectedKnowledge: true,
};

export const DEFAULT_MAINTENANCE_POLICY: Required<MaintenancePolicy> = {
  workingMemoryTtlSeconds: 30 * 24 * 60 * 60,
  completedWorkItemTtlSeconds: 14 * 24 * 60 * 60,
  knowledgeStaleAfterSeconds: 60 * 24 * 60 * 60,
  minKnowledgeAccessCount: 1,
  maxActiveKnowledgeItems: 500,
  consolidateKnowledge: false,
  trustedCoreRetentionDays: 365,
  provisionalRetentionDays: 14,
  disputedRetentionDays: 90,
  reverificationCadenceDays: 30,
  classRetentionOverrides: {
    identity: 3650,
    preference: 365,
    constraint: 365,
    procedure: 180,
    strategy: 180,
    anti_pattern: 365,
    project_fact: 90,
    episodic_fact: 14,
  },
  requireReconfirmationForProjectFacts: true,
  preserveEvidenceForTrustedKnowledge: true,
};
