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
}

export interface ContextPolicy {
  maxKnowledgeItems?: number;
  maxRecentSummaries?: number;
  tokenBudget?: number;
  lexicalWeight?: number;
  semanticWeight?: number;
  recencyWeight?: number;
  importanceWeight?: number;
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
};

export const DEFAULT_CONTEXT_POLICY: Required<ContextPolicy> = {
  maxKnowledgeItems: 20,
  maxRecentSummaries: 3,
  tokenBudget: Number.MAX_SAFE_INTEGER,
  lexicalWeight: 1,
  semanticWeight: 1,
  recencyWeight: 1,
  importanceWeight: 0.25,
};
