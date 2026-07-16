import { createHash } from 'crypto';
import { normalizeScope } from '../../contracts/identity.js';
import {
  ProviderUnavailableError,
  ResourceNotFoundError,
  ScopeMismatchError,
  ValidationError,
} from '../../contracts/errors.js';
import { DEFAULT_EXTRACTION_POLICY } from '../../contracts/policy.js';
import type {
  FactConfidence,
  FactType,
  KnowledgeEvidence,
  KnowledgeMemory,
  KnowledgeMemoryAudit,
  KnowledgeTrustAssessment,
  PaginatedResult,
  PaginationOptions,
  Turn,
} from '../../contracts/types.js';
import type {
  CognitiveSearchOptions,
  CognitiveSearchResult,
} from '../../contracts/cognitive.js';
import type { EpisodeSearchOptions, EpisodeSummary } from '../../contracts/types.js';
import type {
  ReflectOnKnowledgeOptions,
  KnowledgeReflectionResult,
} from '../../contracts/reflection.js';
import type { DeriveOptions, DerivedOutput } from '../../contracts/derived.js';
import type { CurationOptions, CurationSummary } from '../../contracts/curation.js';
import type { CoreMemoryOptions, CoreMemoryBundle } from '../../contracts/core-memory.js';
import type { AliasCandidate, AliasMap } from '../../contracts/aliases.js';
import type { OntologyConfig } from '../../contracts/ontology.js';
import type {
  BundleExportOptions,
  BundleImportOptions,
  MemoryBundle,
} from '../../contracts/bundles.js';
import { assessKnowledgeReverification } from '../trust.js';
import {
  computeNextReverificationAt,
  getDueReverificationKnowledge,
  resolveMaintenancePolicy,
} from '../knowledge-lifecycle.js';
import { searchEpisodes, summarizeEpisode } from '../episodic.js';
import { searchCognitive } from '../cognitive.js';
import { reflectOnKnowledge } from '../reflection.js';
import { derive } from '../derived.js';
import { getCurationSummary, type CurationInput } from '../curation.js';
import { getCoreMemory } from '../core-memory.js';
import { discoverAliasCandidates, type DiscoverAliasCandidatesOptions } from '../aliases.js';
import { exportAsMarkdown } from '../markdown-export.js';
import {
  exportBundle,
  importBundle,
  type ExportBundleResult,
  type ImportBundleResult,
} from '../bundles.js';
import {
  refreshDocuments,
  type DocumentDescriptor,
  type RefreshResult,
} from '../corpus-refresh.js';
import {
  parseAliases,
  parseOntology,
  SCOPE_CONFIG_KEYS,
  serializeAliases,
  serializeOntology,
} from '../scope-config.js';
import { emitMemoryEvent } from '../telemetry.js';
import { estimateTokens } from '../tokens.js';
import {
  entityMatchesScope,
  knowledgeMatchesScope,
  manualKnowledgeClassForFactType,
  mergeTurnsById,
  resolveSyncAdapter,
} from '../manager-support.js';
import type { MaintenanceReport } from '../maintenance.js';
import type { CapabilityContext } from './context.js';

/**
 * Curation namespace (Phase 6.2): knowledge lifecycle and higher-order
 * knowledge operations — reverification, candidate/evidence inspection,
 * reflection/derivation, curation summaries, document ingestion/export,
 * bundles, aliases/ontology config, and episodic/cognitive analysis. This
 * capability OWNS the mutable curation caches (last maintenance/reflection/
 * derived results + timestamps) that feed {@link getCurationSummary} — these
 * were previously closure state in the manager factory (item 3).
 */
export interface CurationCapability {
  inspectKnowledge(id: number): Promise<{
    knowledge: KnowledgeMemory | null;
    evidence: KnowledgeEvidence[];
    audits: KnowledgeMemoryAudit[];
  }>;
  listKnowledge(options?: PaginationOptions): Promise<PaginatedResult<KnowledgeMemory>>;
  getKnowledgeAudits(options?: {
    knowledgeId?: number;
    limit?: number;
  }): Promise<KnowledgeMemoryAudit[]>;
  getDueReverification(options?: { limit?: number }): Promise<KnowledgeMemory[]>;
  reverifyKnowledge(id: number): Promise<KnowledgeTrustAssessment>;
  runReverification(options?: { limit?: number }): Promise<{
    reverifiedKnowledgeIds: number[];
    demotedKnowledgeIds: number[];
  }>;
  reembedKnowledge(options?: { batchSize?: number }): Promise<{ reembeddedIds: number[] }>;
  searchEpisodes(options: EpisodeSearchOptions): Promise<EpisodeSummary[]>;
  summarizeEpisode(
    sessionId: string,
    options?: { detailLevel?: EpisodeSummary['detailLevel'] },
  ): Promise<EpisodeSummary>;
  searchCognitive(options: CognitiveSearchOptions): Promise<CognitiveSearchResult>;
  reflectOnKnowledge(options?: ReflectOnKnowledgeOptions): Promise<KnowledgeReflectionResult>;
  derive(options?: DeriveOptions): Promise<DerivedOutput[]>;
  getCurationSummary(
    input?: Partial<CurationInput>,
    options?: CurationOptions,
  ): Promise<CurationSummary>;
  getCoreMemory(options?: CoreMemoryOptions): Promise<CoreMemoryBundle>;
  ingestDocument(
    content: string,
    options: { title: string; url?: string; mimeType?: string; metadata?: Record<string, string> },
  ): Promise<{ document: import('../../contracts/types.js').SourceDocument; knowledge: KnowledgeMemory[] }>;
  getSourceDocument(id: number): Promise<import('../../contracts/types.js').SourceDocument | null>;
  listSourceDocuments(
    options?: PaginationOptions,
  ): Promise<PaginatedResult<import('../../contracts/types.js').SourceDocument>>;
  exportAsMarkdown(
    options?: import('../../contracts/export.js').MarkdownExportOptions,
  ): Promise<import('../../contracts/export.js').MarkdownExportResult>;
  promoteResponse(
    turnId: number,
    options?: { factTypes?: FactType[]; minConfidence?: FactConfidence },
  ): Promise<KnowledgeMemory[]>;
  setAliases(aliasMap: AliasMap): void;
  getAliases(): AliasMap | undefined;
  saveAliases(aliasMap: AliasMap): Promise<void>;
  loadAliases(): Promise<AliasMap | undefined>;
  getAliasCandidates(options?: DiscoverAliasCandidatesOptions): Promise<AliasCandidate[]>;
  setOntology(ontology: OntologyConfig): void;
  getOntology(): OntologyConfig | undefined;
  saveOntology(ontology: OntologyConfig): Promise<void>;
  loadOntology(): Promise<OntologyConfig | undefined>;
  exportBundle(name: string, options?: Partial<BundleExportOptions>): ExportBundleResult;
  importBundle(bundle: MemoryBundle, options: BundleImportOptions): ImportBundleResult;
  refreshDocuments(documents: DocumentDescriptor[]): RefreshResult;
}

export interface CurationModule {
  namespace: CurationCapability;
  /**
   * Record the latest maintenance report into the curation cache. Called by
   * the top-level `runMaintenance` daily driver so a later
   * {@link CurationCapability.getCurationSummary} auto-populates without args.
   */
  recordMaintenance(report: MaintenanceReport, timestamp: number): void;
}

export function createCurationCapability(ctx: CapabilityContext): CurationModule {
  const {
    asyncAdapter,
    config,
    onEvent,
    circuitBreakers,
    activeEmbeddingModel,
    emitKnowledgeChange,
    emitDegradation,
    maybeEmbedKnowledge,
  } = ctx;

  // Curation caches (item 3): auto-populate the curation summary from the most
  // recent maintenance/reflection/derivation the manager has run.
  let lastMaintenanceReport: MaintenanceReport | undefined;
  let lastMaintenanceTimestamp: number | undefined;
  let lastReflectionResult: KnowledgeReflectionResult | undefined;
  let lastReflectionTimestamp: number | undefined;
  let lastDerivedOutputs: DerivedOutput[] | undefined;
  let lastDerivedTimestamp: number | undefined;

  const namespace: CurationCapability = {
    async inspectKnowledge(id) {
      const knowledge = await asyncAdapter.getKnowledgeMemoryById(id);
      if (!knowledge || !knowledgeMatchesScope(knowledge, config.scope)) {
        return { knowledge: null, evidence: [], audits: [] };
      }
      const evidence = await asyncAdapter.listKnowledgeEvidenceForKnowledge(id);
      const audits = await asyncAdapter.getKnowledgeMemoryAuditsForKnowledge(
        config.scope,
        id,
        50,
      );
      return { knowledge, evidence, audits };
    },

    async listKnowledge(options) {
      return asyncAdapter.getActiveKnowledgeMemoryPaginated(config.scope, options);
    },

    async getKnowledgeAudits(options) {
      if (options?.knowledgeId != null) {
        return asyncAdapter.getKnowledgeMemoryAuditsForKnowledge(
          config.scope,
          options.knowledgeId,
          options.limit ?? 20,
        );
      }
      return asyncAdapter.getRecentKnowledgeMemoryAudits(config.scope, options?.limit ?? 20);
    },

    async getDueReverification(options) {
      const now = Math.floor(Date.now() / 1000);
      const maintenancePolicy = resolveMaintenancePolicy(config.maintenancePolicy);
      const activeKnowledge = await asyncAdapter.getActiveKnowledgeMemory(config.scope);
      return getDueReverificationKnowledge(activeKnowledge, maintenancePolicy, now).slice(
        0,
        options?.limit ?? activeKnowledge.length,
      );
    },

    async reverifyKnowledge(id) {
      const knowledge = await asyncAdapter.getKnowledgeMemoryById(id);
      if (!knowledge) {
        throw new ResourceNotFoundError(`Memory validation: knowledge memory ${id} was not found`);
      }
      if (!knowledgeMatchesScope(knowledge, config.scope)) {
        throw new ScopeMismatchError(
          `Memory validation: knowledge memory ${id} does not belong to the requested scope`,
        );
      }
      const evidence = await asyncAdapter.listKnowledgeEvidenceForKnowledge(id);
      const policy = {
        ...DEFAULT_EXTRACTION_POLICY,
        ...config.extractionPolicy,
      };
      const assessment = assessKnowledgeReverification({
        knowledge,
        evidence,
        policy,
      });
      const supportEvidence = evidence.filter((item) => item.support_polarity === 'supports');
      const successCount = supportEvidence.filter((item) => item.outcome === 'success').length;
      const failureCount = supportEvidence.filter((item) => item.outcome === 'failure').length;
      const now = Math.floor(Date.now() / 1000);
      const maintenancePolicy = resolveMaintenancePolicy(config.maintenancePolicy);
      const nextReverificationAt = computeNextReverificationAt(
        {
          ...knowledge,
          knowledge_state: assessment.state,
          last_verified_at: now,
          last_confirmed_at:
            assessment.state === 'trusted' ? now : knowledge.last_confirmed_at,
          confirmation_count:
            assessment.state === 'trusted'
              ? knowledge.confirmation_count + 1
              : knowledge.confirmation_count,
        },
        maintenancePolicy,
      );
      const updated = await asyncAdapter.updateKnowledgeMemory(id, {
        knowledge_state: assessment.state,
        knowledge_class:
          failureCount > successCount &&
          ['strategy', 'procedure'].includes(knowledge.knowledge_class)
            ? 'anti_pattern'
            : successCount > 0 &&
                assessment.state === 'trusted' &&
                knowledge.knowledge_class === 'procedure'
              ? 'strategy'
              : knowledge.knowledge_class,
        trust_score: assessment.trust_score,
        verification_status:
          assessment.state === 'trusted'
            ? 'verified'
            : assessment.state === 'provisional'
              ? 'corroborated'
              : 'unverified',
        verification_notes: assessment.reasons.join(', ') || null,
        last_verified_at: now,
        next_reverification_at: nextReverificationAt,
        last_confirmed_at: assessment.state === 'trusted' ? now : knowledge.last_confirmed_at,
        confirmation_count:
          assessment.state === 'trusted'
            ? knowledge.confirmation_count + 1
            : knowledge.confirmation_count,
        disputed_at: assessment.state === 'disputed' ? now : knowledge.disputed_at,
        dispute_reason: assessment.state === 'disputed' ? assessment.reasons.join(', ') : knowledge.dispute_reason,
        contradiction_score:
          assessment.state === 'disputed'
            ? Math.max(knowledge.contradiction_score, 1)
            : knowledge.contradiction_score,
        successful_use_count: knowledge.successful_use_count + successCount,
        failed_use_count: knowledge.failed_use_count + failureCount,
      });
      if (updated) {
        emitKnowledgeChange(assessment.state === 'trusted' ? 'reverified' : 'demoted', updated);
      }
      return assessment;
    },

    async runReverification(options) {
      const now = Math.floor(Date.now() / 1000);
      const maintenancePolicy = resolveMaintenancePolicy(config.maintenancePolicy);
      const activeKnowledge = await asyncAdapter.getActiveKnowledgeMemory(config.scope);
      const due = getDueReverificationKnowledge(activeKnowledge, maintenancePolicy, now).slice(
        0,
        options?.limit ?? activeKnowledge.length,
      );
      const reverifiedKnowledgeIds: number[] = [];
      const demotedKnowledgeIds: number[] = [];
      for (const item of due) {
        const assessment = await this.reverifyKnowledge(item.id);
        reverifiedKnowledgeIds.push(item.id);
        if (assessment.state !== 'trusted') {
          demotedKnowledgeIds.push(item.id);
        }
      }
      return { reverifiedKnowledgeIds, demotedKnowledgeIds };
    },

    async reembedKnowledge(options) {
      // Phase 2.4: batch re-embed active knowledge whose stored (model,
      // dimensions) mismatch the active provider (or has no stored vector).
      // No-op without a provider; TODO(plan 6.3) transport routes deferred.
      const reembeddedIds: number[] = [];
      if (!config.embeddingAdapter || !config.embeddingGenerator) {
        return { reembeddedIds };
      }
      const batchSize = Math.max(1, options?.batchSize ?? 50);
      const activeKnowledge = await asyncAdapter.getActiveKnowledgeMemory(config.scope);

      // Probe the active provider's dimensionality once.
      let activeDims: number | undefined;
      try {
        const [probe] = await circuitBreakers.embeddings.execute(() =>
          config.embeddingGenerator!(['__reembed_probe__']),
        );
        activeDims = probe?.length;
      } catch {
        activeDims = undefined;
      }

      // D3: staleness is metadata-aware. A stored embedding is stale when
      // dimensions differ from the active provider OR (the active model is known
      // AND the stored model differs) — the same-dimension model swap that a
      // length-only check misses. getEmbeddingMetadata exposes the stored model;
      // adapters that predate it fall back to a length-only check.
      const readMetadata = config.embeddingAdapter.getEmbeddingMetadata?.bind(
        config.embeddingAdapter,
      );
      const stale: KnowledgeMemory[] = [];
      for (const item of activeKnowledge) {
        if (readMetadata) {
          const meta = await readMetadata(item.id);
          if (
            !meta ||
            (activeDims != null && meta.dimensions !== activeDims) ||
            (activeEmbeddingModel !== 'unknown' && meta.model !== activeEmbeddingModel)
          ) {
            stale.push(item);
          }
        } else {
          const stored = await config.embeddingAdapter.getEmbedding(item.id);
          if (!stored || (activeDims != null && stored.length !== activeDims)) {
            stale.push(item);
          }
        }
      }

      for (let i = 0; i < stale.length; i += batchSize) {
        const batch = stale.slice(i, i + batchSize);
        try {
          const vectors = await circuitBreakers.embeddings.execute(() =>
            config.embeddingGenerator!(batch.map((item) => item.fact)),
          );
          for (const [index, item] of batch.entries()) {
            const vector = vectors[index];
            if (!vector) continue;
            await config.embeddingAdapter!.storeEmbedding(item.id, vector, {
              model: activeEmbeddingModel,
              dimensions: vector.length,
            });
            reembeddedIds.push(item.id);
          }
        } catch (error) {
          config.logger?.warn('memory.embeddings.reembed_failed', {
            error: String(error),
            batchStart: i,
            batchSize: batch.length,
          });
          emitDegradation('embeddings', {
            stage: 'reembed',
            error: String(error),
            batchStart: i,
          });
        }
      }

      emitMemoryEvent('manager', config.scope, { logger: config.logger, onEvent }, 0, {
        action: 'reembed_knowledge',
        activeModel: activeEmbeddingModel,
        activeDimensions: activeDims ?? null,
        candidateCount: stale.length,
        reembeddedCount: reembeddedIds.length,
      });

      return { reembeddedIds };
    },

    async searchEpisodes(options) {
      if (!config.structuredClient) {
        throw new ProviderUnavailableError(
          'searchEpisodes requires a structuredClient in MemoryManagerConfig',
        );
      }
      return searchEpisodes(
        {
          adapter: asyncAdapter,
          scope: config.scope,
          client: config.structuredClient,
          telemetry: { logger: config.logger, onEvent },
        },
        options,
      );
    },

    async summarizeEpisode(sessionId, options) {
      if (!config.structuredClient) {
        throw new ProviderUnavailableError(
          'summarizeEpisode requires a structuredClient in MemoryManagerConfig',
        );
      }
      const detailLevel = options?.detailLevel ?? 'overview';
      // Fetch both active and all session working memories. Partially
      // compacted sessions have BOTH archived history (covered by working
      // memory turn ranges) and active turns; a recap built from only the
      // active fragment silently drops earlier context, so we always merge
      // archived + active and dedupe by turn id.
      const activeTurns = await asyncAdapter.getActiveTurns(config.scope, sessionId);
      const allSessionWm = await asyncAdapter.getWorkingMemoryBySession(sessionId, config.scope);
      let archivedTurns: Turn[] = [];
      if (allSessionWm.length > 0) {
        const minStart = Math.min(...allSessionWm.map((wm) => wm.turn_id_start));
        const maxEnd = Math.max(...allSessionWm.map((wm) => wm.turn_id_end));
        archivedTurns = await asyncAdapter.getArchivedTurnRange(sessionId, minStart, maxEnd, config.scope);
      }
      const turns = mergeTurnsById(archivedTurns, activeTurns);
      return summarizeEpisode(
        {
          adapter: asyncAdapter,
          scope: config.scope,
          client: config.structuredClient,
          telemetry: { logger: config.logger, onEvent },
        },
        { turns, workingMemories: allSessionWm, sessionId, detailLevel, client: config.structuredClient },
      );
    },

    async searchCognitive(options) {
      return searchCognitive(asyncAdapter, config.scope, options);
    },

    async reflectOnKnowledge(options) {
      const result = await reflectOnKnowledge(asyncAdapter, config.scope, {
        ...options,
        scope: options?.scope ?? normalizeScope(config.scope),
        existingAliases: options?.existingAliases ?? config.aliasMap,
      }, config.extractor);
      lastReflectionResult = result;
      lastReflectionTimestamp = Math.floor(Date.now() / 1000);
      return result;
    },

    async derive(options) {
      const deriveScope = options?.scope ?? config.scope;
      const reflection = await reflectOnKnowledge(asyncAdapter, deriveScope, {
        existingAliases: config.aliasMap,
      }, config.extractor);
      const activeKnowledge = await asyncAdapter.getActiveKnowledgeMemory(deriveScope);
      const outputs = derive(reflection, activeKnowledge, options);
      lastDerivedOutputs = outputs;
      lastDerivedTimestamp = Math.floor(Date.now() / 1000);
      return outputs;
    },

    async getCurationSummary(input, options) {
      // Auto-populate from cached manager state when caller provides no input
      const merged: CurationInput = {
        maintenance: input?.maintenance ?? lastMaintenanceReport,
        maintenanceTimestamp: input?.maintenanceTimestamp ?? lastMaintenanceTimestamp,
        reflection: input?.reflection ?? lastReflectionResult,
        reflectionTimestamp: input?.reflectionTimestamp ?? lastReflectionTimestamp,
        derived: input?.derived ?? lastDerivedOutputs,
        derivedTimestamp: input?.derivedTimestamp ?? lastDerivedTimestamp,
        ontologyActions: input?.ontologyActions,
      };
      return getCurationSummary(merged, options);
    },

    async getCoreMemory(options) {
      return getCoreMemory(asyncAdapter, config.scope, options);
    },

    async ingestDocument(content, options) {
      if (!config.extractor) {
        throw new ValidationError('An extractor is required for document ingestion');
      }
      const contentHash = createHash('sha256').update(content).digest('hex');
      const existing = await asyncAdapter.getSourceDocumentByHash(contentHash, config.scope);
      if (existing) {
        return { document: existing, knowledge: [] };
      }
      const doc = await asyncAdapter.insertSourceDocument({
        ...config.scope,
        title: options.title,
        content_hash: contentHash,
        mime_type: options.mimeType ?? 'text/plain',
        url: options.url ?? null,
        metadata: options.metadata ?? {},
        token_estimate: estimateTokens(content),
      });
      const facts = await config.extractor(content, [], []);
      const created: KnowledgeMemory[] = [];
      for (const fact of facts) {
        const km = await asyncAdapter.insertKnowledgeMemory({
          ...config.scope,
          fact: config.redactText ? config.redactText({ kind: 'fact', text: fact.fact }) : fact.fact,
          fact_type: fact.factType,
          knowledge_class: manualKnowledgeClassForFactType(fact.factType),
          source: 'manual',
          confidence: fact.confidence,
        });
        created.push(km);
      }
      await maybeEmbedKnowledge(created);
      await asyncAdapter.updateSourceDocument(doc.id, {
        status: 'processed',
        fact_count: created.length,
        processed_at: Math.floor(Date.now() / 1000),
      });
      const updated = await asyncAdapter.getSourceDocumentById(doc.id);
      return { document: updated ?? { ...doc, status: 'processed' as const, fact_count: created.length, processed_at: Math.floor(Date.now() / 1000) }, knowledge: created };
    },

    async getSourceDocument(id) {
      const doc = await asyncAdapter.getSourceDocumentById(id);
      if (!doc) return null;
      if (!entityMatchesScope(doc, config.scope)) return null;
      return doc;
    },

    async listSourceDocuments(options) {
      return asyncAdapter.listSourceDocuments(config.scope, options);
    },

    async exportAsMarkdown(options) {
      return exportAsMarkdown(asyncAdapter, config.scope, options);
    },

    async promoteResponse(turnId, options) {
      if (!config.extractor) {
        throw new ValidationError('An extractor is required for response promotion');
      }
      const turn = await asyncAdapter.getTurnById(turnId);
      if (!turn) {
        throw new ResourceNotFoundError(`Turn ${turnId} not found`);
      }
      if (!entityMatchesScope(turn, config.scope)) {
        throw new ScopeMismatchError(`Turn ${turnId} does not belong to the current scope`);
      }
      if (turn.role !== 'assistant') {
        throw new ValidationError('promoteResponse supports only assistant turns');
      }
      const facts = await config.extractor(turn.content, [], []);
      const created: KnowledgeMemory[] = [];
      for (const fact of facts) {
        if (options?.factTypes && !options.factTypes.includes(fact.factType)) continue;
        if (options?.minConfidence) {
          const levels: Record<string, number> = { low: 0, medium: 1, high: 2 };
          if ((levels[fact.confidence] ?? 0) < (levels[options.minConfidence] ?? 0)) continue;
        }
        const km = await asyncAdapter.insertKnowledgeMemory({
          ...config.scope,
          fact: config.redactText ? config.redactText({ kind: 'fact', text: fact.fact }) : fact.fact,
          fact_type: fact.factType,
          knowledge_class: manualKnowledgeClassForFactType(fact.factType),
          source: 'manual',
          confidence: fact.confidence,
        });
        created.push(km);
      }
      await maybeEmbedKnowledge(created);
      return created;
    },

    setAliases(aliasMap) {
      config.aliasMap = aliasMap;
    },

    getAliases() {
      return config.aliasMap;
    },

    async saveAliases(aliasMap) {
      config.aliasMap = aliasMap;
      await asyncAdapter.setScopeConfig(
        config.scope,
        SCOPE_CONFIG_KEYS.aliases,
        serializeAliases(aliasMap),
      );
    },

    async loadAliases() {
      const stored = await asyncAdapter.getScopeConfig(config.scope, SCOPE_CONFIG_KEYS.aliases);
      const aliasMap = parseAliases(stored);
      if (aliasMap) {
        config.aliasMap = aliasMap;
      }
      return aliasMap;
    },

    async getAliasCandidates(options) {
      const knowledge = await asyncAdapter.getActiveKnowledgeMemory(config.scope);
      return discoverAliasCandidates(knowledge, {
        ...options,
        existingAliases: options?.existingAliases ?? config.aliasMap,
      });
    },

    setOntology(ontology) {
      config.ontology = ontology;
    },

    getOntology() {
      return config.ontology;
    },

    async saveOntology(ontology) {
      config.ontology = ontology;
      await asyncAdapter.setScopeConfig(
        config.scope,
        SCOPE_CONFIG_KEYS.ontology,
        serializeOntology(ontology),
      );
    },

    async loadOntology() {
      const stored = await asyncAdapter.getScopeConfig(config.scope, SCOPE_CONFIG_KEYS.ontology);
      const ontology = parseOntology(stored);
      if (ontology) {
        config.ontology = ontology;
      }
      return ontology;
    },

    exportBundle(name, options) {
      return exportBundle(resolveSyncAdapter(config, asyncAdapter, 'exportBundle()'), name, {
        ...options,
        scope: config.scope, // Always enforce manager's scope
      });
    },

    importBundle(bundle, options) {
      return importBundle(resolveSyncAdapter(config, asyncAdapter, 'importBundle()'), bundle, options);
    },

    refreshDocuments(documents) {
      return refreshDocuments(
        resolveSyncAdapter(config, asyncAdapter, 'refreshDocuments()'),
        config.scope,
        documents,
      );
    },
  };

  return {
    namespace,
    recordMaintenance(report, timestamp) {
      lastMaintenanceReport = report;
      lastMaintenanceTimestamp = timestamp;
    },
  };
}
