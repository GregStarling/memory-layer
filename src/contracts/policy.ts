export type ConflictStrategy = 'supersede' | 'keep_both' | 'skip';
export type ContextMode = 'chat' | 'coding' | 'autonomous_agent' | 'review';

export interface MaintenancePolicy {
  workingMemoryTtlSeconds?: number;
  completedWorkItemTtlSeconds?: number;
  knowledgeStaleAfterSeconds?: number;
  minKnowledgeAccessCount?: number;
  maxActiveKnowledgeItems?: number;
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
}

export interface ExtractionPolicy {
  autoExtractAfterCompaction?: boolean;
  maxFactsPerExtraction?: number;
  deduplicateFacts?: boolean;
  touchDuplicates?: boolean;
  minConfidenceForPromotion?: 'high' | 'medium';
  conflictStrategy?: ConflictStrategy;
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
  diversityPenalty?: number;
  maxPerFactType?: number;
  touchSelectedKnowledge?: boolean;
}

export const DEFAULT_MONITOR_POLICY: Required<MonitorPolicy> = {
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
};

export const DEFAULT_EXTRACTION_POLICY: Required<ExtractionPolicy> = {
  autoExtractAfterCompaction: true,
  maxFactsPerExtraction: 10,
  deduplicateFacts: true,
  touchDuplicates: true,
  minConfidenceForPromotion: 'medium',
  conflictStrategy: 'supersede',
};

export const DEFAULT_CONTEXT_POLICY: Required<ContextPolicy> = {
  maxKnowledgeItems: 20,
  maxRecentSummaries: 3,
  mode: 'chat',
  tokenBudget: Number.MAX_SAFE_INTEGER,
  lexicalWeight: 1,
  semanticWeight: 1,
  recencyWeight: 1,
  importanceWeight: 0.25,
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
};
