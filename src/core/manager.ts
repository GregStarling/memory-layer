import type { EmbeddingAdapter, EmbeddingGenerator } from '../contracts/embedding.js';
import type { MemoryScope } from '../contracts/identity.js';
import type { EventHook, Logger } from '../contracts/observability.js';
import type {
  ContextPolicy,
  ExtractionPolicy,
  MonitorPolicy,
} from '../contracts/policy.js';
import type { StorageAdapter } from '../contracts/storage.js';
import type {
  FactConfidence,
  FactType,
  KnowledgeMemory,
  SearchOptions,
  SearchResult,
  Turn,
  TurnRole,
  WorkingMemory,
} from '../contracts/types.js';
import { buildMemoryContext, type MemoryContext } from './context.js';
import type { Extractor } from './extractor.js';
import {
  compactTurns,
  extractKnowledge,
  type CompactionResult,
  type Summarizer,
} from './orchestrator.js';
import { assessContext } from './monitor.js';
import { emitMemoryEvent } from './telemetry.js';

export interface MemoryManagerConfig {
  adapter: StorageAdapter;
  scope: MemoryScope;
  sessionId: string;
  summarizer: Summarizer;
  extractor?: Extractor;
  embeddingAdapter?: EmbeddingAdapter;
  embeddingGenerator?: EmbeddingGenerator;
  logger?: Logger;
  onEvent?: EventHook;
  monitorPolicy?: MonitorPolicy;
  extractionPolicy?: ExtractionPolicy;
  contextPolicy?: ContextPolicy;
  autoCompact?: boolean;
  autoExtract?: boolean;
}

export interface MemoryManager {
  processTurn(role: TurnRole, content: string, actor?: string): Promise<Turn>;
  getContext(relevanceQuery?: string): MemoryContext;
  search(
    query: string,
    options?: SearchOptions,
  ): { turns: SearchResult<Turn>[]; knowledge: SearchResult<KnowledgeMemory>[] };
  forceCompact(): Promise<CompactionResult | null>;
  learnFact(fact: string, factType: FactType, confidence?: FactConfidence): KnowledgeMemory;
  close(): void;
}

export function createMemoryManager(config: MemoryManagerConfig): MemoryManager {
  const autoCompact = config.autoCompact ?? true;
  const autoExtract = config.autoExtract ?? Boolean(config.extractor);

  async function maybeEmbedKnowledge(knowledge: KnowledgeMemory[]): Promise<void> {
    if (!config.embeddingAdapter || !config.embeddingGenerator || knowledge.length === 0) {
      return;
    }
    const vectors = await config.embeddingGenerator(knowledge.map((item) => item.fact));
    knowledge.forEach((item, index) => {
      const vector = vectors[index];
      if (vector) {
        config.embeddingAdapter!.storeEmbedding(item.id, vector);
      }
    });
  }

  async function runCompaction(turns: Turn[]): Promise<CompactionResult | null> {
    const report = assessContext(
      {
        scope: config.scope,
        session_id: config.sessionId,
        active_turns: turns,
        latest_working_memory: config.adapter.getLatestWorkingMemory(config.scope),
      },
      config.monitorPolicy,
    );

    if (report.recommendation.action === 'none') {
      return null;
    }

    const result = await compactTurns(
      config.adapter,
      config.scope,
      config.sessionId,
      turns,
      config.summarizer,
      report.recommendation.action,
      Math.max(0, Math.min(report.recommendation.post_compaction_target_turns, turns.length - 1)),
      { logger: config.logger, onEvent: config.onEvent },
    );

    if (config.extractor && autoExtract) {
      const extracted = await extractKnowledge(
        config.adapter,
        result.workingMemory.id,
        config.scope,
        config.extractor,
        {
          logger: config.logger,
          onEvent: config.onEvent,
          policy: config.extractionPolicy,
        },
      );
      await maybeEmbedKnowledge(extracted);
    }

    return result;
  }

  return {
    async processTurn(role, content, actor = role === 'assistant' ? 'assistant' : 'user') {
      const turn = config.adapter.insertTurn({
        ...config.scope,
        session_id: config.sessionId,
        actor,
        role,
        content,
      });

      emitMemoryEvent('manager', config.scope, config, 0, {
        action: 'process_turn',
        role,
        turnId: turn.id,
      });

      if (autoCompact) {
        await runCompaction(config.adapter.getActiveTurns(config.scope));
      }

      return turn;
    },

    getContext(relevanceQuery) {
      return buildMemoryContext(config.adapter, config.scope, {
        relevanceQuery,
        policy: config.contextPolicy,
        logger: config.logger,
        onEvent: config.onEvent,
      });
    },

    search(query, options) {
      return {
        turns: config.adapter.searchTurns(config.scope, query, options),
        knowledge: config.adapter.searchKnowledge(config.scope, query, options),
      };
    },

    async forceCompact() {
      return runCompaction(config.adapter.getActiveTurns(config.scope));
    },

    learnFact(fact, factType, confidence = 'high') {
      const knowledge = config.adapter.insertKnowledgeMemory({
        ...config.scope,
        fact,
        fact_type: factType,
        source: 'manual',
        confidence,
      });
      emitMemoryEvent('manager', config.scope, config, 0, {
        action: 'learn_fact',
        knowledgeMemoryId: knowledge.id,
        factType,
      });
      return knowledge;
    },

    close() {
      config.adapter.close();
    },
  };
}
