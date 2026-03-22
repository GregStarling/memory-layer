import type { ScopeLevel } from '../contracts/identity.js';
import type {
  ContextPolicy,
  ExtractionPolicy,
  MaintenancePolicy,
  MonitorPolicy,
} from '../contracts/policy.js';

export type MemoryManagerPreset = 'ai_ide' | 'chat_agent' | 'autonomous_agent';

export interface MemoryManagerPresetConfig {
  monitorPolicy: Partial<MonitorPolicy>;
  extractionPolicy: Partial<ExtractionPolicy>;
  contextPolicy: Partial<ContextPolicy>;
  maintenancePolicy: Partial<MaintenancePolicy>;
  crossScopeLevel: ScopeLevel;
  autoCompact: boolean;
  autoExtract: boolean;
}

export const MEMORY_MANAGER_PRESETS: Record<MemoryManagerPreset, MemoryManagerPresetConfig> = {
  ai_ide: {
    monitorPolicy: {
      softTurnThreshold: 18,
      hardTurnThreshold: 30,
      softTokenThreshold: 3500,
      hardTokenThreshold: 6500,
      softRetainTurns: 10,
      hardRetainTurns: 6,
    },
    extractionPolicy: {
      autoExtractAfterCompaction: true,
      maxFactsPerExtraction: 8,
      deduplicateFacts: true,
      touchDuplicates: true,
      minConfidenceForPromotion: 'medium',
    },
    contextPolicy: {
      mode: 'coding',
      maxKnowledgeItems: 16,
      maxRecentSummaries: 4,
      touchSelectedKnowledge: true,
    },
    maintenancePolicy: {
      workingMemoryTtlSeconds: 14 * 24 * 60 * 60,
      completedWorkItemTtlSeconds: 7 * 24 * 60 * 60,
      knowledgeStaleAfterSeconds: 45 * 24 * 60 * 60,
    },
    crossScopeLevel: 'workspace',
    autoCompact: true,
    autoExtract: true,
  },
  chat_agent: {
    monitorPolicy: {
      softTurnThreshold: 14,
      hardTurnThreshold: 24,
      softTokenThreshold: 2800,
      hardTokenThreshold: 5200,
      softRetainTurns: 10,
      hardRetainTurns: 8,
    },
    extractionPolicy: {
      autoExtractAfterCompaction: true,
      maxFactsPerExtraction: 6,
      deduplicateFacts: true,
      touchDuplicates: true,
      minConfidenceForPromotion: 'medium',
    },
    contextPolicy: {
      mode: 'chat',
      maxKnowledgeItems: 12,
      maxRecentSummaries: 3,
      touchSelectedKnowledge: true,
    },
    maintenancePolicy: {
      workingMemoryTtlSeconds: 7 * 24 * 60 * 60,
      completedWorkItemTtlSeconds: 7 * 24 * 60 * 60,
      knowledgeStaleAfterSeconds: 30 * 24 * 60 * 60,
    },
    crossScopeLevel: 'scope',
    autoCompact: true,
    autoExtract: true,
  },
  autonomous_agent: {
    monitorPolicy: {
      softTurnThreshold: 10,
      hardTurnThreshold: 18,
      softTokenThreshold: 2400,
      hardTokenThreshold: 4800,
      softRetainTurns: 8,
      hardRetainTurns: 5,
    },
    extractionPolicy: {
      autoExtractAfterCompaction: true,
      maxFactsPerExtraction: 12,
      deduplicateFacts: true,
      touchDuplicates: true,
      minConfidenceForPromotion: 'medium',
    },
    contextPolicy: {
      mode: 'autonomous_agent',
      maxKnowledgeItems: 20,
      maxRecentSummaries: 5,
      touchSelectedKnowledge: true,
    },
    maintenancePolicy: {
      workingMemoryTtlSeconds: 3 * 24 * 60 * 60,
      completedWorkItemTtlSeconds: 3 * 24 * 60 * 60,
      knowledgeStaleAfterSeconds: 21 * 24 * 60 * 60,
    },
    crossScopeLevel: 'workspace',
    autoCompact: true,
    autoExtract: true,
  },
};

export function resolveMemoryManagerPreset(
  preset: MemoryManagerPreset = 'chat_agent',
): MemoryManagerPresetConfig {
  return MEMORY_MANAGER_PRESETS[preset];
}
