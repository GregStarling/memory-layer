import type { MemoryScope } from '../contracts/identity.js';
import { normalizeScope } from '../contracts/identity.js';
import type { EventHook, Logger } from '../contracts/observability.js';
import {
  ResourceNotFoundError,
  ScopeMismatchError,
  ValidationError,
} from '../contracts/errors.js';
import type { ConflictStrategy, ExtractionPolicy } from '../contracts/policy.js';
import { DEFAULT_EXTRACTION_POLICY } from '../contracts/policy.js';
import type { AsyncStorageAdapter } from '../contracts/async-storage.js';
import type { StorageAdapter } from '../contracts/storage.js';
import { UniqueConstraintError } from '../contracts/storage.js';
import type {
  Association,
  CompactionTrigger,
  EvidenceSourceType,
  FactConfidence,
  FactType,
  GroundingStrength,
  KnowledgeConflict,
  KnowledgeClass,
  KnowledgeDecision,
  KnowledgeMemory,
  KnowledgeMemoryAudit,
  KnowledgeRelation,
  NewAssociation,
  NewKnowledgeEvidence,
  Turn,
  VerificationStatus,
  WorkingMemory,
} from '../contracts/types.js';
import {
  assertCompactionTrigger,
  assertFactConfidence,
  assertFactType,
  assertFactType as assertExtractedFactType,
  assertNonEmpty,
  assertStringArray,
  assertMaxEntries,
  nowSeconds,
} from './validation.js';
import {
  classifyFactRelation,
  createRegexExtractor,
  normalizeFactText,
  normalizeExtractedFact,
  normalizeKnowledgeMemory,
  type Extractor,
  type NormalizedExtractedFact,
} from './extractor.js';
import { emitMemoryEvent } from './telemetry.js';
import { assessCandidateTrust, buildKnowledgeConflict } from './trust.js';
import { getNativeSyncAdapter } from '../contracts/native-sync.js';
import { autoDetectAssociations } from './associations.js';
import type { AliasMap } from '../contracts/aliases.js';
import { resolveAliases } from './aliases.js';

export interface CompactionResult {
  workingMemory: WorkingMemory;
  compactionLog: import('../contracts/types.js').CompactionLog;
  archivedTurnIds: number[];
}

export interface SummarizerOutput {
  summary: string;
  key_entities: string[];
  topic_tags: string[];
}

export type Summarizer = (turns: Turn[]) => Promise<SummarizerOutput>;

export type KnowledgeVerifier = (
  fact: NormalizedExtractedFact,
  context: {
    workingMemory: WorkingMemory;
    sourceTurns: Turn[];
    relatedKnowledge: KnowledgeMemory[];
  },
) => Promise<
  | boolean
  | {
      approved?: boolean;
      confidence?: FactConfidence;
      confidenceScore?: number;
      verificationStatus?: VerificationStatus;
      notes?: string | null;
    }
>;

interface WorkflowTelemetry {
  logger?: Logger;
  onEvent?: EventHook;
}

type KnowledgeCandidateInput = Parameters<StorageAdapter['insertKnowledgeCandidate']>[0];
type KnowledgeEvidenceInput = Parameters<StorageAdapter['insertKnowledgeEvidenceBatch']>[0][number];
type KnowledgeAuditInput = Parameters<StorageAdapter['insertKnowledgeMemoryAudit']>[0];
type PromotedKnowledgeInput = Parameters<StorageAdapter['promoteKnowledgeCandidate']>[1];

interface KnowledgeRelationMatch {
  relation: KnowledgeRelation | 'created';
  related: KnowledgeMemory | null;
}

interface PromotionPersistencePlan {
  candidateInput: KnowledgeCandidateInput;
  candidateEvidenceInputs: KnowledgeEvidenceInput[];
  promotedKnowledgeInput: PromotedKnowledgeInput;
  auditInput: KnowledgeAuditInput;
  supersededKnowledgeId: number | null;
}

type MaybePromise<T> = T | Promise<T>;

interface CandidatePersistenceOps<
  TCandidate extends { id: number },
  TEvidence extends { id: number } & KnowledgeEvidenceInput,
> {
  insertKnowledgeCandidate(input: KnowledgeCandidateInput): MaybePromise<TCandidate>;
  insertKnowledgeEvidenceBatch(inputs: KnowledgeEvidenceInput[]): MaybePromise<TEvidence[]>;
}

interface PromotionPersistenceOps<
  TCandidate extends { id: number },
  TEvidence extends { id: number } & KnowledgeEvidenceInput,
> extends CandidatePersistenceOps<TCandidate, TEvidence> {
  promoteKnowledgeCandidate(
    candidateId: number,
    input: PromotedKnowledgeInput,
  ): MaybePromise<KnowledgeMemory>;
  supersedeKnowledgeMemory(oldId: number, newId: number): MaybePromise<void>;
  insertAssociation(input: NewAssociation): MaybePromise<Association>;
  insertKnowledgeMemoryAudit(input: KnowledgeAuditInput): MaybePromise<KnowledgeMemoryAudit>;
}

function resolveExtractionPolicy(
  policy?: ExtractionPolicy,
): Required<ExtractionPolicy> {
  return {
    ...DEFAULT_EXTRACTION_POLICY,
    ...policy,
  };
}

function confidenceScore(confidence: FactConfidence): number {
  if (confidence === 'high') return 3;
  if (confidence === 'medium') return 2;
  return 1;
}

function meetsConfidenceThreshold(
  confidence: FactConfidence,
  minimum: FactConfidence,
): boolean {
  return confidenceScore(confidence) >= confidenceScore(minimum);
}

function buildKnowledgeInput(
  scope: ReturnType<typeof normalizeScope>,
  workingMemoryId: number,
  fact: NormalizedExtractedFact,
  options: {
    confidence: FactConfidence;
    confidenceScore: number;
    trustScore: number;
    knowledgeState: 'provisional' | 'trusted';
    knowledgeClass: KnowledgeClass;
    verificationStatus: VerificationStatus;
    verificationNotes?: string | null;
    contradictionScore?: number;
    disputeReason?: string | null;
    sourceTurnIds: number[];
  },
) {
  return {
    ...scope,
    fact: fact.fact,
    fact_type: fact.factType,
    knowledge_state: options.knowledgeState,
    knowledge_class: options.knowledgeClass,
    fact_subject: fact.subject,
    fact_attribute: fact.attribute,
    fact_value: fact.value,
    normalized_fact: fact.normalizedFact,
    slot_key: fact.slotKey,
    is_negated: fact.isNegated,
    source: 'promoted_from_working' as const,
    confidence: options.confidence,
    confidence_score: options.confidenceScore,
    grounding_strength:
      (options.sourceTurnIds.length >= 2
        ? 'strong'
        : options.sourceTurnIds.length === 1
          ? 'moderate'
          : 'weak') as GroundingStrength,
    evidence_count: options.sourceTurnIds.length,
    trust_score: options.trustScore,
    verification_status: options.verificationStatus,
    verification_notes: options.verificationNotes ?? null,
    last_verified_at: options.verificationStatus === 'unverified' ? null : nowSeconds(),
    source_working_memory_id: workingMemoryId,
    source_turn_ids: options.sourceTurnIds,
    contradiction_score: options.contradictionScore ?? 0,
    dispute_reason: options.disputeReason ?? null,
    valid_from: fact.valid_from ?? null,
    valid_until: fact.valid_until ?? null,
    rationale: fact.rationale ?? null,
  };
}

function deriveConfidenceScore(
  confidence: FactConfidence,
  sourceTurnCount: number,
  relation: KnowledgeRelation | 'created',
): number {
  const base = confidence === 'high' ? 0.85 : confidence === 'medium' ? 0.65 : 0.4;
  const corroborationBoost = Math.min(0.1, Math.max(0, sourceTurnCount - 1) * 0.05);
  const conflictPenalty = relation === 'conflict' ? 0.1 : 0;
  return Math.max(0, Math.min(1, base + corroborationBoost - conflictPenalty));
}

function deriveVerificationStatus(
  sourceTurnCount: number,
  override?: VerificationStatus,
): VerificationStatus {
  if (override) return override;
  return sourceTurnCount >= 2 ? 'corroborated' : 'unverified';
}

function mapFactTypeToKnowledgeClass(factType: FactType): KnowledgeClass {
  if (factType === 'entity') return 'identity';
  if (factType === 'preference') return 'preference';
  if (factType === 'constraint') return 'constraint';
  if (factType === 'decision') return 'procedure';
  return 'project_fact';
}

function mergeRecoveredFacts(
  extracted: NormalizedExtractedFact[],
  recovered: NormalizedExtractedFact[],
  maxFactsPerExtraction: number,
): NormalizedExtractedFact[] {
  const merged: NormalizedExtractedFact[] = [];
  const seen = new Set<string>();
  for (const fact of [...extracted, ...recovered]) {
    const key = `${fact.factType}:${fact.slotKey ?? fact.normalizedFact}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(fact);
    if (merged.length >= maxFactsPerExtraction) break;
  }
  return merged;
}

function resolveCreatedKnowledgeClass(
  knowledgeClass: KnowledgeClass,
  knowledgeState: 'provisional' | 'trusted',
  evidence: Array<Pick<NewKnowledgeEvidence, 'support_polarity' | 'outcome'>>,
): KnowledgeClass {
  const supportEvidence = evidence.filter((item) => item.support_polarity === 'supports');
  const outcomeFailures = supportEvidence.filter((item) => item.outcome === 'failure').length;
  const outcomeSuccesses = supportEvidence.filter((item) => item.outcome === 'success').length;
  if (outcomeFailures > outcomeSuccesses && ['strategy', 'procedure'].includes(knowledgeClass)) {
    return 'anti_pattern';
  }
  if (knowledgeState === 'trusted' && knowledgeClass === 'procedure' && outcomeSuccesses > 0) {
    return 'strategy';
  }
  return knowledgeClass;
}

function shouldSupersedeExistingKnowledge(
  relation: KnowledgeRelation | 'created',
  relatedKnowledge: KnowledgeMemory | null,
  decision: KnowledgeDecision,
  conflictStrategy: ConflictStrategy,
): relatedKnowledge is KnowledgeMemory {
  return Boolean(
    relatedKnowledge &&
      (decision === 'supersede_existing' ||
        relation === 'update' ||
        (relation === 'conflict' && conflictStrategy === 'supersede')),
  );
}

function buildPromotionAuditPayload(input: {
  normalizedScope: ReturnType<typeof normalizeScope>;
  workingMemoryId: number;
  fact: NormalizedExtractedFact;
  confidence: FactConfidence;
  confidenceScore: number;
  verificationStatus: VerificationStatus;
  sourceText: string;
  relation: KnowledgeRelation | 'created';
  createdKnowledgeId: number;
  relatedKnowledgeId: number | null;
  verificationNotes: string | null;
  conflictStrategy: ConflictStrategy;
}): Parameters<StorageAdapter['insertKnowledgeMemoryAudit']>[0] {
  return {
    ...input.normalizedScope,
    working_memory_id: input.workingMemoryId,
    fact: input.fact.fact,
    fact_type: input.fact.factType,
    fact_subject: input.fact.subject,
    fact_attribute: input.fact.attribute,
    fact_value: input.fact.value,
    normalized_fact: input.fact.normalizedFact,
    slot_key: input.fact.slotKey,
    is_negated: input.fact.isNegated,
    confidence: input.confidence,
    confidence_score: input.confidenceScore,
    verification_status: input.verificationStatus,
    source_text: input.sourceText,
    decision:
      input.relation === 'update'
        ? 'updated'
        : input.relation === 'conflict'
          ? 'conflict'
          : input.relation === 'compatible'
            ? 'compatible'
            : 'created',
    created_knowledge_id: input.createdKnowledgeId,
    related_knowledge_id: input.relatedKnowledgeId,
    detail:
      input.relation === 'conflict'
        ? input.verificationNotes ?? `Conflict strategy '${input.conflictStrategy}'`
        : input.relation === 'update'
          ? input.verificationNotes ?? 'Superseded prior related knowledge'
          : input.relation === 'compatible'
            ? input.verificationNotes ?? 'Created alongside compatible related knowledge'
            : input.verificationNotes ?? 'Created new knowledge memory',
  };
}

function bindCandidateEvidenceToCandidate(
  candidateEvidenceInputs: KnowledgeEvidenceInput[],
  candidateId: number,
): KnowledgeEvidenceInput[] {
  return candidateEvidenceInputs.map((item) => ({
    ...item,
    knowledge_candidate_id: candidateId,
  }));
}

function bindCandidateEvidenceToKnowledge(
  candidateEvidence: Array<{ id: number } & KnowledgeEvidenceInput>,
  knowledgeId: number,
): KnowledgeEvidenceInput[] {
  return candidateEvidence.map(({ id: _id, ...item }) => ({
    ...item,
    knowledge_candidate_id: null,
    knowledge_memory_id: knowledgeId,
  }));
}

function isPromiseLike<T>(value: MaybePromise<T>): value is Promise<T> {
  return typeof value === 'object' && value !== null && 'then' in value;
}

function chainMaybe<T, U>(
  value: MaybePromise<T>,
  next: (value: T) => MaybePromise<U>,
): MaybePromise<U> {
  return isPromiseLike(value) ? value.then(next) : next(value);
}

function attemptMaybe<T>(
  work: () => MaybePromise<T>,
  onError: (error: unknown) => MaybePromise<T>,
): MaybePromise<T> {
  try {
    const result = work();
    return isPromiseLike(result) ? result.catch(onError) : result;
  } catch (error) {
    return onError(error);
  }
}

function assertSyncResult<T>(value: MaybePromise<T>): T {
  if (isPromiseLike(value)) {
    throw new Error('Expected synchronous persistence result');
  }
  return value;
}

function ignoreUniqueConstraint(error: unknown): void {
  if (!(error instanceof UniqueConstraintError)) {
    throw error;
  }
}

function buildPromotionPersistencePlan(input: {
  normalizedScope: ReturnType<typeof normalizeScope>;
  workingMemoryId: number;
  fact: NormalizedExtractedFact;
  candidateInput: KnowledgeCandidateInput;
  candidateEvidenceInputs: KnowledgeEvidenceInput[];
  grounded: ReturnType<typeof groundFactAgainstTurns>;
  trustAssessment: ReturnType<typeof assessCandidateTrust>;
  strongestRelation: KnowledgeRelationMatch;
  resolvedConfidence: FactConfidence;
  resolvedConfidenceScore: number;
  resolvedVerificationStatus: VerificationStatus;
  verificationNotes: string | null;
  conflict: KnowledgeConflict | null;
  policy: Required<ExtractionPolicy>;
}): PromotionPersistencePlan {
  const promotedState = input.trustAssessment.state === 'trusted' ? 'trusted' : 'provisional';
  const createdKnowledgeClass = resolveCreatedKnowledgeClass(
    input.grounded.candidate.knowledge_class,
    promotedState,
    input.candidateEvidenceInputs,
  );
  const promotedKnowledgeInput = buildKnowledgeInput(
    input.normalizedScope,
    input.workingMemoryId,
    input.fact,
    {
      confidence: input.resolvedConfidence,
      confidenceScore: input.resolvedConfidenceScore,
      trustScore: input.trustAssessment.trust_score,
      knowledgeState: promotedState,
      knowledgeClass: createdKnowledgeClass,
      verificationStatus: input.resolvedVerificationStatus,
      verificationNotes:
        input.verificationNotes ??
        (input.trustAssessment.reasons.length > 0
          ? input.trustAssessment.reasons.join(', ')
          : null),
      contradictionScore: input.conflict?.severity === 'high' ? 1 : 0,
      sourceTurnIds: input.grounded.supportedTurnIds,
    },
  );
  const auditInput = buildPromotionAuditPayload({
    normalizedScope: input.normalizedScope,
    workingMemoryId: input.workingMemoryId,
    fact: input.fact,
    confidence: input.resolvedConfidence,
    confidenceScore: input.trustAssessment.trust_score,
    verificationStatus: input.resolvedVerificationStatus,
    sourceText: input.fact.sourceText ?? input.fact.fact,
    relation: input.strongestRelation.relation,
    createdKnowledgeId: 0,
    relatedKnowledgeId: input.strongestRelation.related?.id ?? null,
    verificationNotes: input.verificationNotes,
    conflictStrategy: input.policy.conflictStrategy,
  });
  return {
    candidateInput: input.candidateInput,
    candidateEvidenceInputs: input.candidateEvidenceInputs,
    promotedKnowledgeInput,
    auditInput,
    supersededKnowledgeId: shouldSupersedeExistingKnowledge(
      input.strongestRelation.relation,
      input.strongestRelation.related,
      input.trustAssessment.decision,
      input.policy.conflictStrategy,
    )
      ? input.strongestRelation.related.id
      : null,
  };
}

function persistRejectedKnowledgeCandidateCore<
  TCandidate extends { id: number },
  TEvidence extends { id: number } & KnowledgeEvidenceInput,
>(
  adapter: CandidatePersistenceOps<TCandidate, TEvidence>,
  candidateInput: KnowledgeCandidateInput,
  candidateEvidenceInputs: KnowledgeEvidenceInput[],
): MaybePromise<void> {
  return chainMaybe(adapter.insertKnowledgeCandidate(candidateInput), (rejectedCandidate) => {
    if (candidateEvidenceInputs.length === 0) {
      return undefined;
    }
    return chainMaybe(
      adapter.insertKnowledgeEvidenceBatch(
        bindCandidateEvidenceToCandidate(candidateEvidenceInputs, rejectedCandidate.id),
      ),
      () => undefined,
    );
  });
}

async function persistRejectedKnowledgeCandidateAsync(
  adapter: AsyncStorageAdapter,
  candidateInput: KnowledgeCandidateInput,
  candidateEvidenceInputs: KnowledgeEvidenceInput[],
): Promise<void> {
  await Promise.resolve(
    persistRejectedKnowledgeCandidateCore(adapter, candidateInput, candidateEvidenceInputs),
  );
}

function persistRejectedKnowledgeCandidateSync(
  adapter: StorageAdapter,
  candidateInput: KnowledgeCandidateInput,
  candidateEvidenceInputs: KnowledgeEvidenceInput[],
): void {
  assertSyncResult(
    persistRejectedKnowledgeCandidateCore(adapter, candidateInput, candidateEvidenceInputs),
  );
}

function persistPromotedKnowledgeCore<
  TCandidate extends { id: number },
  TEvidence extends { id: number } & KnowledgeEvidenceInput,
>(
  adapter: PromotionPersistenceOps<TCandidate, TEvidence>,
  normalizedScope: ReturnType<typeof normalizeScope>,
  plan: PromotionPersistencePlan,
): MaybePromise<KnowledgeMemory> {
  return chainMaybe(adapter.insertKnowledgeCandidate(plan.candidateInput), (candidate) => {
    const candidateEvidenceResult: MaybePromise<TEvidence[]> =
      plan.candidateEvidenceInputs.length > 0
        ? adapter.insertKnowledgeEvidenceBatch(
            bindCandidateEvidenceToCandidate(plan.candidateEvidenceInputs, candidate.id),
          )
        : [];
    return chainMaybe(candidateEvidenceResult, (candidateEvidence) =>
      chainMaybe(
        adapter.promoteKnowledgeCandidate(candidate.id, plan.promotedKnowledgeInput),
        (knowledge) =>
          chainMaybe(
            candidateEvidence.length > 0
              ? adapter.insertKnowledgeEvidenceBatch(
                  bindCandidateEvidenceToKnowledge(candidateEvidence, knowledge.id),
                )
              : undefined,
            () =>
              chainMaybe(
                plan.supersededKnowledgeId != null
                  ? chainMaybe(
                      adapter.supersedeKnowledgeMemory(plan.supersededKnowledgeId, knowledge.id),
                      () =>
                        attemptMaybe(
                          () =>
                            adapter.insertAssociation({
                              ...normalizedScope,
                              source_kind: 'knowledge',
                              source_id: knowledge.id,
                              target_kind: 'knowledge',
                              target_id: plan.supersededKnowledgeId!,
                              association_type: 'supersedes',
                              confidence: 1,
                              auto_generated: true,
                            }),
                          (error) => {
                            ignoreUniqueConstraint(error);
                            return undefined;
                          },
                        ),
                    )
                  : undefined,
                () =>
                  chainMaybe(
                    adapter.insertKnowledgeMemoryAudit({
                      ...plan.auditInput,
                      created_knowledge_id: knowledge.id,
                    }),
                    () => knowledge,
                  ),
              ),
          ),
      ),
    );
  });
}

async function persistPromotedKnowledgeAsync(
  adapter: AsyncStorageAdapter,
  normalizedScope: ReturnType<typeof normalizeScope>,
  plan: PromotionPersistencePlan,
): Promise<KnowledgeMemory> {
  return Promise.resolve(persistPromotedKnowledgeCore(adapter, normalizedScope, plan));
}

function persistPromotedKnowledgeSync(
  adapter: StorageAdapter,
  normalizedScope: ReturnType<typeof normalizeScope>,
  plan: PromotionPersistencePlan,
): KnowledgeMemory {
  return assertSyncResult(persistPromotedKnowledgeCore(adapter, normalizedScope, plan));
}

function evidenceSourceTypeForTurn(turn: Turn): EvidenceSourceType {
  if (turn.role === 'assistant') return 'assistant_turn';
  if (turn.role === 'system') return 'system_turn';
  return 'user_turn';
}

function tokenizeForGrounding(text: string): string[] {
  return normalizeFactText(text)
    .split(/[^a-z0-9]+/g)
    .filter((token) => token.length >= 3);
}

function buildEvidenceExcerpt(turn: Turn, fact: NormalizedExtractedFact): string {
  const sourceText = normalizeFactText(fact.sourceText ?? fact.fact);
  const lowered = turn.content.toLowerCase();
  if (sourceText.length > 0) {
    const index = lowered.indexOf(sourceText);
    if (index >= 0) {
      return turn.content.slice(index, Math.min(turn.content.length, index + Math.max(80, sourceText.length)));
    }
  }
  return turn.content.slice(0, 160);
}

function containsContradictionCue(text: string): boolean {
  return /\b(?:avoid|avoids|not|never|cannot|can't|must not|should not|do not|does not)\b/.test(text);
}

function groundFactAgainstTurns(
  scope: ReturnType<typeof normalizeScope>,
  workingMemoryId: number,
  fact: NormalizedExtractedFact,
  turns: Turn[],
): {
  candidate: {
    fact: string;
    fact_type: FactType;
    knowledge_class: KnowledgeClass;
    normalized_fact: string;
    slot_key: string | null;
    confidence: FactConfidence;
    source_summary: boolean;
    source_turns: boolean;
    grounding_strength: GroundingStrength;
    evidence_count: number;
    trust_score: number;
    state: 'candidate' | 'provisional';
  };
  evidence: Array<Omit<NewKnowledgeEvidence, keyof import('../contracts/identity.js').MemoryScope>>;
  supportedTurnIds: number[];
} {
  const sourceText = normalizeFactText(fact.sourceText ?? fact.fact);
  const factTokens = new Set(tokenizeForGrounding(fact.sourceText ?? fact.fact));
  const evidence: Array<Omit<NewKnowledgeEvidence, keyof import('../contracts/identity.js').MemoryScope>> = [];
  const supportedTurnIds: number[] = [];
  let strongestExplicitness = 0;

  for (const turn of turns) {
    const lowered = normalizeFactText(turn.content);
    const exactMatch = sourceText.length > 0 && lowered.includes(sourceText);
    const tokenHits = [...factTokens].filter((token) => lowered.includes(token)).length;
    const overlap = factTokens.size > 0 ? tokenHits / factTokens.size : 0;
    const matched = exactMatch || overlap >= 0.6 || tokenHits >= 3;
    if (!matched) continue;
    const contradictory =
      !fact.isNegated &&
      containsContradictionCue(lowered) &&
      !containsContradictionCue(sourceText);

    const explicitnessScore = exactMatch ? 1 : Math.min(0.95, 0.45 + overlap * 0.4);
    strongestExplicitness = Math.max(strongestExplicitness, explicitnessScore);
    if (!contradictory) {
      supportedTurnIds.push(turn.id);
    }
    evidence.push({
      knowledge_candidate_id: null,
      knowledge_memory_id: null,
      working_memory_id: workingMemoryId,
      turn_id: turn.id,
      source_type: evidenceSourceTypeForTurn(turn),
      support_polarity: contradictory ? 'contradicts' : 'supports',
      speaker_role: turn.role,
      actor: turn.actor,
      excerpt: buildEvidenceExcerpt(turn, fact),
      start_offset: null,
      end_offset: null,
      is_explicit: exactMatch,
      explicitness_score: explicitnessScore,
      outcome: null,
    });
  }

  const groundingStrength: GroundingStrength =
    supportedTurnIds.length >= 2
      ? 'strong'
      : supportedTurnIds.length === 1
        ? strongestExplicitness >= 0.85
          ? 'strong'
          : 'moderate'
        : 'weak';
  const trustScore =
    supportedTurnIds.length === 0 ? 0.15 : Math.min(0.95, 0.45 + strongestExplicitness * 0.4);

  return {
    candidate: {
      fact: fact.fact,
      fact_type: fact.factType,
      knowledge_class: mapFactTypeToKnowledgeClass(fact.factType),
      normalized_fact: fact.normalizedFact,
      slot_key: fact.slotKey,
      confidence: fact.confidence,
      source_summary: true,
      source_turns: supportedTurnIds.length > 0,
      grounding_strength: groundingStrength,
      evidence_count: supportedTurnIds.length,
      trust_score: trustScore,
      state: supportedTurnIds.length > 0 ? 'provisional' : 'candidate',
    },
    evidence,
    supportedTurnIds,
  };
}

function sortTurnsAscending(turns: Turn[]): Turn[] {
  return [...turns].sort((a, b) => a.id - b.id);
}

async function runAtomicStorage<T>(
  adapter: AsyncStorageAdapter,
  runAsync: () => Promise<T>,
  runSync: (syncAdapter: StorageAdapter) => T,
): Promise<T> {
  const syncAdapter = getNativeSyncAdapter(adapter);
  if (syncAdapter) {
    return Promise.resolve(syncAdapter.transaction(() => runSync(syncAdapter)));
  }
  return adapter.transaction(runAsync);
}

function assertTurnsMatchScope(turns: Turn[], scope: MemoryScope, sessionId: string): void {
  const normalized = normalizeScope(scope);
  for (const turn of turns) {
    if (turn.session_id !== sessionId) {
      throw new ValidationError(
        `Memory validation: turn ${turn.id} session_id '${turn.session_id}' does not match '${sessionId}'`,
      );
    }
    if (
      turn.tenant_id !== normalized.tenant_id ||
      turn.system_id !== normalized.system_id ||
      turn.workspace_id !== normalized.workspace_id ||
      turn.collaboration_id !== normalized.collaboration_id ||
      turn.scope_id !== normalized.scope_id
    ) {
      throw new ScopeMismatchError(
        `Memory validation: turn ${turn.id} does not belong to the requested scope`,
      );
    }
  }
}

export async function commitCompaction(
  adapter: AsyncStorageAdapter,
  input: {
    scope: MemoryScope;
    sessionId: string;
    summary: string;
    keyEntities: string[];
    topicTags: string[];
    turnsToArchive: Turn[];
    activeTurnCountBefore: number;
    activeTurnCountAfter: number;
    trigger: CompactionTrigger;
    durationMs: number;
    modelCallMade: boolean;
    logger?: Logger;
    onEvent?: EventHook;
  },
): Promise<CompactionResult> {
  const normalizedScope = normalizeScope(input.scope);
  assertNonEmpty(input.sessionId, 'sessionId');
  assertNonEmpty(input.summary, 'summary');
  assertCompactionTrigger(input.trigger, 'trigger');
  assertStringArray(input.keyEntities, 'keyEntities');
  assertStringArray(input.topicTags, 'topicTags');
  assertMaxEntries(input.topicTags, 'topicTags', 5);

  const turnsToArchive = sortTurnsAscending(input.turnsToArchive);
  if (turnsToArchive.length === 0) {
    throw new ValidationError("Memory validation: 'turnsToArchive' must not be empty");
  }
  assertTurnsMatchScope(turnsToArchive, normalizedScope, input.sessionId);

  const turnIdStart = turnsToArchive[0].id;
  const turnIdEnd = turnsToArchive[turnsToArchive.length - 1].id;
  const tokensCompactedEstimate = turnsToArchive.reduce(
    (acc, turn) => acc + turn.token_estimate,
    0,
  );
  const archivedAt = nowSeconds();

  return runAtomicStorage(
    adapter,
    async () => {
      const workingMemory = await adapter.insertWorkingMemory({
        ...normalizedScope,
        session_id: input.sessionId,
        summary: input.summary,
        key_entities: input.keyEntities,
        topic_tags: input.topicTags,
        turn_id_start: turnIdStart,
        turn_id_end: turnIdEnd,
        turn_count: turnsToArchive.length,
        compaction_trigger: input.trigger,
      });

      const compactionLog = await adapter.insertCompactionLog({
        ...normalizedScope,
        session_id: input.sessionId,
        trigger_type: input.trigger,
        turn_id_start: turnIdStart,
        turn_id_end: turnIdEnd,
        turns_compacted: turnsToArchive.length,
        tokens_compacted_estimate: tokensCompactedEstimate,
        working_memory_id: workingMemory.id,
        active_turn_count_before: input.activeTurnCountBefore,
        active_turn_count_after: input.activeTurnCountAfter,
        duration_ms: input.durationMs,
        model_call_made: input.modelCallMade,
      });

      for (const turn of turnsToArchive) {
        await adapter.archiveTurn(turn.id, archivedAt, compactionLog.id);
      }

      return {
        workingMemory,
        compactionLog,
        archivedTurnIds: turnsToArchive.map((turn) => turn.id),
      };
    },
    (syncAdapter) => {
      const workingMemory = syncAdapter.insertWorkingMemory({
        ...normalizedScope,
        session_id: input.sessionId,
        summary: input.summary,
        key_entities: input.keyEntities,
        topic_tags: input.topicTags,
        turn_id_start: turnIdStart,
        turn_id_end: turnIdEnd,
        turn_count: turnsToArchive.length,
        compaction_trigger: input.trigger,
      });

      const compactionLog = syncAdapter.insertCompactionLog({
        ...normalizedScope,
        session_id: input.sessionId,
        trigger_type: input.trigger,
        turn_id_start: turnIdStart,
        turn_id_end: turnIdEnd,
        turns_compacted: turnsToArchive.length,
        tokens_compacted_estimate: tokensCompactedEstimate,
        working_memory_id: workingMemory.id,
        active_turn_count_before: input.activeTurnCountBefore,
        active_turn_count_after: input.activeTurnCountAfter,
        duration_ms: input.durationMs,
        model_call_made: input.modelCallMade,
      });

      for (const turn of turnsToArchive) {
        syncAdapter.archiveTurn(turn.id, archivedAt, compactionLog.id);
      }

      return {
        workingMemory,
        compactionLog,
        archivedTurnIds: turnsToArchive.map((turn) => turn.id),
      };
    },
  ).then((result) => {
    emitMemoryEvent('compaction', normalizedScope, input, input.durationMs, {
      trigger: input.trigger,
      archivedTurnCount: turnsToArchive.length,
      activeTurnCountBefore: input.activeTurnCountBefore,
      activeTurnCountAfter: input.activeTurnCountAfter,
      workingMemoryId: result.workingMemory.id,
      compactionLogId: result.compactionLog.id,
    });
    return result;
  });
}

export async function compactTurns(
  adapter: AsyncStorageAdapter,
  scope: MemoryScope,
  sessionId: string,
  turnsToCompact: Turn[],
  summarize: Summarizer,
  trigger: CompactionTrigger,
  retainedTurnCount: number,
  telemetry?: WorkflowTelemetry,
): Promise<CompactionResult> {
  assertCompactionTrigger(trigger, 'trigger');
  if (!Number.isInteger(retainedTurnCount) || retainedTurnCount < 0) {
    throw new ValidationError(
      `Memory validation: 'retainedTurnCount' must be a non-negative integer, got '${retainedTurnCount}'`,
    );
  }

  const orderedTurns = sortTurnsAscending(turnsToCompact);
  assertTurnsMatchScope(orderedTurns, scope, sessionId);
  const turnsToArchive = orderedTurns.slice(0, Math.max(0, orderedTurns.length - retainedTurnCount));
  if (turnsToArchive.length === 0) {
    throw new ValidationError('Memory validation: no turns are eligible for compaction');
  }

  const startedAtMs = Date.now();
  const summary = await summarize(turnsToArchive);
  const durationMs = Date.now() - startedAtMs;

  return commitCompaction(adapter, {
    scope,
    sessionId,
    summary: summary.summary,
    keyEntities: summary.key_entities,
    topicTags: summary.topic_tags,
    turnsToArchive,
    activeTurnCountBefore: orderedTurns.length,
    activeTurnCountAfter: orderedTurns.length - turnsToArchive.length,
    trigger,
    durationMs,
    modelCallMade: true,
    ...telemetry,
  });
}

export async function promoteToKnowledge(
  adapter: AsyncStorageAdapter,
  workingMemoryId: number,
  input: {
    scope: MemoryScope;
    fact: string;
    factType: FactType;
    confidence: FactConfidence;
    logger?: Logger;
    onEvent?: EventHook;
  },
): Promise<KnowledgeMemory> {
  assertNonEmpty(input.fact, 'fact');
  assertFactType(input.factType);
  assertFactConfidence(input.confidence);

  const normalizedScope = normalizeScope(input.scope);
  const workingMemory = await adapter.getWorkingMemoryById(workingMemoryId);
  if (!workingMemory) {
    throw new ResourceNotFoundError(
      `Memory validation: working memory ${workingMemoryId} was not found`,
    );
  }
  if (
    workingMemory.tenant_id !== normalizedScope.tenant_id ||
    workingMemory.system_id !== normalizedScope.system_id ||
    workingMemory.workspace_id !== normalizedScope.workspace_id ||
    workingMemory.collaboration_id !== normalizedScope.collaboration_id ||
    workingMemory.scope_id !== normalizedScope.scope_id
  ) {
    throw new ScopeMismatchError(
      `Memory validation: working memory ${workingMemoryId} does not belong to the requested scope`,
    );
  }

  return runAtomicStorage(
    adapter,
    async () => {
      const knowledgeMemory = await adapter.insertKnowledgeMemory({
        ...normalizedScope,
        fact: input.fact,
        fact_type: input.factType,
        source: 'promoted_from_working',
        confidence: input.confidence,
        confidence_score: deriveConfidenceScore(input.confidence, 1, 'created'),
        verification_status: 'unverified',
        source_working_memory_id: workingMemoryId,
        source_turn_ids: [],
      });
      await adapter.markWorkingMemoryPromoted(workingMemoryId, knowledgeMemory.id);
      return knowledgeMemory;
    },
    (syncAdapter) => {
      const knowledgeMemory = syncAdapter.insertKnowledgeMemory({
        ...normalizedScope,
        fact: input.fact,
        fact_type: input.factType,
        source: 'promoted_from_working',
        confidence: input.confidence,
        confidence_score: deriveConfidenceScore(input.confidence, 1, 'created'),
        verification_status: 'unverified',
        source_working_memory_id: workingMemoryId,
        source_turn_ids: [],
      });
      syncAdapter.markWorkingMemoryPromoted(workingMemoryId, knowledgeMemory.id);
      return knowledgeMemory;
    },
  ).then((knowledgeMemory) => {
    emitMemoryEvent('promotion', normalizedScope, input, 0, {
      workingMemoryId,
      knowledgeMemoryId: knowledgeMemory.id,
      factType: input.factType,
    });
    return knowledgeMemory;
  });
}

export async function extractKnowledge(
  adapter: AsyncStorageAdapter,
  workingMemoryId: number,
  scope: MemoryScope,
  extractor: Extractor,
  options?: {
    logger?: Logger;
    onEvent?: EventHook;
    policy?: ExtractionPolicy;
    verifier?: KnowledgeVerifier;
    aliasMap?: AliasMap;
  },
): Promise<KnowledgeMemory[]> {
  const startedAt = Date.now();
  const normalizedScope = normalizeScope(scope);
  const policy = resolveExtractionPolicy(options?.policy);
  const workingMemory = await adapter.getWorkingMemoryById(workingMemoryId);
  if (!workingMemory) {
    throw new ResourceNotFoundError(
      `Memory validation: working memory ${workingMemoryId} was not found`,
    );
  }
  if (
    workingMemory.tenant_id !== normalizedScope.tenant_id ||
    workingMemory.system_id !== normalizedScope.system_id ||
    workingMemory.workspace_id !== normalizedScope.workspace_id ||
    workingMemory.collaboration_id !== normalizedScope.collaboration_id ||
    workingMemory.scope_id !== normalizedScope.scope_id
  ) {
    throw new ScopeMismatchError(
      `Memory validation: working memory ${workingMemoryId} does not belong to the requested scope`,
    );
  }

  const extracted = (await extractor(
    workingMemory.summary,
    workingMemory.key_entities,
    workingMemory.topic_tags,
  ))
    .slice(0, policy.maxFactsPerExtraction)
    .map(normalizeExtractedFact);
  const archivedSourceTurns = await adapter.getArchivedTurnRange(
    workingMemory.session_id,
    workingMemory.turn_id_start,
    workingMemory.turn_id_end,
    normalizedScope,
  );
  const sourceTurns =
    archivedSourceTurns.length > 0
      ? archivedSourceTurns
      : (
          await Promise.all(
            Array.from(
              { length: workingMemory.turn_id_end - workingMemory.turn_id_start + 1 },
              (_, index) => adapter.getTurnById(workingMemory.turn_id_start + index),
            ),
          )
        ).filter(
          (turn): turn is Turn =>
            turn !== null &&
            turn.session_id === workingMemory.session_id &&
            turn.tenant_id === normalizedScope.tenant_id &&
            turn.system_id === normalizedScope.system_id &&
            turn.workspace_id === normalizedScope.workspace_id &&
            turn.collaboration_id === normalizedScope.collaboration_id &&
            turn.scope_id === normalizedScope.scope_id,
        );
  const recoveredFromTurns = (
    await createRegexExtractor()(
      sourceTurns
        .filter((turn) => turn.role !== 'assistant')
        .map((turn) => turn.content)
        .join(' '),
      workingMemory.key_entities,
      workingMemory.topic_tags,
    )
  )
    .map(normalizeExtractedFact)
    .filter((fact) => ['constraint', 'preference'].includes(fact.factType));
  const mergedFacts = mergeRecoveredFacts(
    extracted,
    recoveredFromTurns,
    policy.maxFactsPerExtraction,
  );
  const { facts: recoveredFacts, resolutions: aliasResolutions } = resolveAliases(
    mergedFacts,
    options?.aliasMap,
  );
  if (aliasResolutions.length > 0 && options?.logger) {
    options.logger.info(
      `Alias resolution applied ${aliasResolutions.length} mapping(s)`,
      { resolutions: aliasResolutions },
    );
  }
  const sourceTurnIds = sourceTurns.map((turn) => turn.id);

  const activeKnowledge = await adapter.getActiveKnowledgeMemory(normalizedScope);
  const duplicateLookup = new Map(
    activeKnowledge.map((fact) => [normalizeFactText(fact.fact), fact]),
  );
  const normalizedKnowledge = activeKnowledge.map((fact) => ({
    memory: fact,
    normalized: normalizeKnowledgeMemory(fact),
  }));

  const created: KnowledgeMemory[] = [];

  for (const fact of recoveredFacts) {
    assertNonEmpty(fact.fact, 'fact');
    assertExtractedFactType(fact.factType);
    assertFactConfidence(fact.confidence);

    if (!meetsConfidenceThreshold(fact.confidence, policy.minConfidenceForPromotion)) {
      await adapter.insertKnowledgeMemoryAudit({
        ...normalizedScope,
        working_memory_id: workingMemoryId,
        fact: fact.fact,
        fact_type: fact.factType,
        fact_subject: fact.subject,
        fact_attribute: fact.attribute,
        fact_value: fact.value,
        normalized_fact: fact.normalizedFact,
        slot_key: fact.slotKey,
        is_negated: fact.isNegated,
        confidence: fact.confidence,
        confidence_score: deriveConfidenceScore(fact.confidence, sourceTurnIds.length, 'created'),
        verification_status: deriveVerificationStatus(sourceTurnIds.length),
        source_text: fact.sourceText ?? fact.fact,
        decision: 'skipped_low_confidence',
        detail: `Below minimum confidence threshold '${policy.minConfidenceForPromotion}'`,
      });
      continue;
    }

    const normalizedFact = normalizeFactText(fact.fact);
    const duplicate = duplicateLookup.get(normalizedFact);
    if (policy.deduplicateFacts && duplicate) {
      if (policy.touchDuplicates) {
        await adapter.touchKnowledgeMemory(duplicate.id);
      }
      await adapter.insertKnowledgeMemoryAudit({
        ...normalizedScope,
        working_memory_id: workingMemoryId,
        fact: fact.fact,
        fact_type: fact.factType,
        fact_subject: fact.subject,
        fact_attribute: fact.attribute,
        fact_value: fact.value,
        normalized_fact: fact.normalizedFact,
        slot_key: fact.slotKey,
        is_negated: fact.isNegated,
        confidence: fact.confidence,
        confidence_score: deriveConfidenceScore(fact.confidence, sourceTurnIds.length, 'duplicate'),
        verification_status: deriveVerificationStatus(sourceTurnIds.length),
        source_text: fact.sourceText ?? fact.fact,
        decision: 'duplicate',
        related_knowledge_id: duplicate.id,
        detail: 'Exact normalized fact already exists',
      });
      continue;
    }

    let strongestRelation: KnowledgeRelationMatch = { relation: 'created', related: null };
    for (const existing of normalizedKnowledge) {
      const relation = classifyFactRelation(existing.normalized, fact);
      if (relation === 'duplicate') {
        strongestRelation = { relation, related: existing.memory };
        break;
      }
      if (relation === 'conflict') {
        strongestRelation = { relation, related: existing.memory };
      } else if (
        relation === 'update' &&
        strongestRelation.relation !== 'conflict'
      ) {
        strongestRelation = { relation, related: existing.memory };
      } else if (
        relation === 'compatible' &&
        strongestRelation.related === null
      ) {
        strongestRelation = { relation, related: existing.memory };
      }
    }

    const verificationResult = options?.verifier
      ? await options.verifier(fact, {
          workingMemory,
          sourceTurns,
          relatedKnowledge: activeKnowledge,
        })
      : undefined;
    const verificationApproved =
      verificationResult === undefined || typeof verificationResult === 'boolean'
        ? verificationResult ?? true
        : verificationResult.approved ?? true;
    const resolvedConfidence =
      verificationResult &&
      typeof verificationResult !== 'boolean' &&
      verificationResult.confidence
        ? verificationResult.confidence
        : fact.confidence;
    const resolvedVerificationStatus = deriveVerificationStatus(
      sourceTurnIds.length,
      verificationResult && typeof verificationResult !== 'boolean'
        ? verificationResult.verificationStatus
        : undefined,
    );
    const resolvedConfidenceScore =
      verificationResult &&
      typeof verificationResult !== 'boolean' &&
      verificationResult.confidenceScore != null
        ? verificationResult.confidenceScore
        : deriveConfidenceScore(resolvedConfidence, sourceTurnIds.length, strongestRelation.relation);
    const verificationNotes =
      verificationResult && typeof verificationResult !== 'boolean'
        ? verificationResult.notes ?? null
        : null;

    if (!verificationApproved) {
      await adapter.insertKnowledgeMemoryAudit({
        ...normalizedScope,
        working_memory_id: workingMemoryId,
        fact: fact.fact,
        fact_type: fact.factType,
        fact_subject: fact.subject,
        fact_attribute: fact.attribute,
        fact_value: fact.value,
        normalized_fact: fact.normalizedFact,
        slot_key: fact.slotKey,
        is_negated: fact.isNegated,
        confidence: resolvedConfidence,
        confidence_score: resolvedConfidenceScore,
        verification_status: resolvedVerificationStatus,
        source_text: fact.sourceText ?? fact.fact,
        decision: 'skipped_low_confidence',
        detail: verificationNotes ?? 'Verifier rejected candidate',
      });
      continue;
    }

    const grounded = groundFactAgainstTurns(normalizedScope, workingMemoryId, fact, sourceTurns);
    const candidateTrustScore = Math.max(
      grounded.candidate.trust_score,
      resolvedConfidenceScore * (grounded.supportedTurnIds.length > 0 ? 0.9 : 0.25),
    );
    const candidateInput = {
      ...normalizedScope,
      working_memory_id: workingMemoryId,
      fact: fact.fact,
      fact_type: fact.factType,
      knowledge_class: grounded.candidate.knowledge_class,
      normalized_fact: grounded.candidate.normalized_fact,
      slot_key: grounded.candidate.slot_key,
      confidence: resolvedConfidence,
      source_summary: grounded.candidate.source_summary,
      source_turns: grounded.candidate.source_turns,
      grounding_strength: grounded.candidate.grounding_strength,
      evidence_count: grounded.candidate.evidence_count,
      trust_score: candidateTrustScore,
      state: grounded.candidate.state,
    };
    const candidatePreview = {
      id: 0,
      ...candidateInput,
      created_at: nowSeconds(),
      promoted_knowledge_id: null,
    };
    const candidateEvidenceInputs = grounded.evidence.map((item) => ({
      ...normalizedScope,
      ...item,
    }));
    const candidateEvidencePreview = candidateEvidenceInputs.map((item, index) => ({
      id: index + 1,
      tenant_id: item.tenant_id,
      system_id: item.system_id,
      workspace_id: item.workspace_id,
      collaboration_id: item.collaboration_id ?? '',
      scope_id: item.scope_id,
      turn_id: item.turn_id ?? null,
      working_memory_id: item.working_memory_id ?? null,
      knowledge_memory_id: null,
      knowledge_candidate_id: candidatePreview.id,
      source_type: item.source_type,
      support_polarity: item.support_polarity,
      speaker_role: item.speaker_role ?? null,
      actor: item.actor ?? null,
      excerpt: item.excerpt,
      start_offset: item.start_offset ?? null,
      end_offset: item.end_offset ?? null,
      is_explicit: item.is_explicit ?? false,
      explicitness_score: item.explicitness_score ?? 0,
      outcome: item.outcome ?? null,
      created_at: item.created_at ?? nowSeconds(),
    }));
    const trustAssessment = assessCandidateTrust({
      candidate: candidatePreview,
      evidence: candidateEvidencePreview,
      policy,
      existingKnowledge: strongestRelation.related,
      relation: strongestRelation.relation,
    });
    const conflict: KnowledgeConflict | null =
      strongestRelation.related && strongestRelation.relation !== 'created'
        ? buildKnowledgeConflict({
            existing: strongestRelation.related,
            candidateId: null,
            relation: strongestRelation.relation,
            contradictionScore: candidateEvidencePreview.some((item) => item.support_polarity === 'contradicts')
              ? 1
              : 0,
            policy,
          })
        : null;

    if (strongestRelation.relation === 'duplicate' && strongestRelation.related) {
      if (policy.touchDuplicates) {
        await adapter.touchKnowledgeMemory(strongestRelation.related.id);
      }
      if (
        strongestRelation.related.knowledge_state !== 'trusted' &&
        trustAssessment.state === 'trusted'
      ) {
        await adapter.updateKnowledgeMemory(strongestRelation.related.id, {
          knowledge_state: 'trusted',
          trust_score: Math.max(strongestRelation.related.trust_score, trustAssessment.trust_score),
          verification_status: resolvedVerificationStatus,
          verification_notes: trustAssessment.reasons.join(', '),
          last_verified_at: nowSeconds(),
        });
      }
      await adapter.insertKnowledgeMemoryAudit({
        ...normalizedScope,
        working_memory_id: workingMemoryId,
        fact: fact.fact,
        fact_type: fact.factType,
        fact_subject: fact.subject,
        fact_attribute: fact.attribute,
        fact_value: fact.value,
        normalized_fact: fact.normalizedFact,
        slot_key: fact.slotKey,
        is_negated: fact.isNegated,
        confidence: resolvedConfidence,
        confidence_score: resolvedConfidenceScore,
        verification_status: resolvedVerificationStatus,
        source_text: fact.sourceText ?? fact.fact,
        decision: 'duplicate',
        related_knowledge_id: strongestRelation.related.id,
        detail:
          verificationNotes ??
          `Structured relation classified as duplicate (${trustAssessment.reasons.join(', ') || 'no extra trust signal'})`,
      });
      continue;
    }

    if (trustAssessment.decision === 'reject_candidate') {
      await runAtomicStorage(
        adapter,
        () =>
          persistRejectedKnowledgeCandidateAsync(
            adapter,
            candidateInput,
            candidateEvidenceInputs,
          ),
        (syncAdapter) =>
          persistRejectedKnowledgeCandidateSync(
            syncAdapter,
            candidateInput,
            candidateEvidenceInputs,
          ),
      );
      await adapter.insertKnowledgeMemoryAudit({
        ...normalizedScope,
        working_memory_id: workingMemoryId,
        fact: fact.fact,
        fact_type: fact.factType,
        fact_subject: fact.subject,
        fact_attribute: fact.attribute,
        fact_value: fact.value,
        normalized_fact: fact.normalizedFact,
        slot_key: fact.slotKey,
        is_negated: fact.isNegated,
        confidence: resolvedConfidence,
        confidence_score: trustAssessment.trust_score,
        verification_status: 'unverified',
        source_text: fact.sourceText ?? fact.fact,
        decision: 'skipped_low_confidence',
        related_knowledge_id: strongestRelation.related?.id ?? null,
        detail: trustAssessment.reasons.join(', ') || 'Rejected by trust assessment',
      });
      continue;
    }

    if (
      strongestRelation.related &&
      (trustAssessment.decision === 'mark_disputed' ||
        (strongestRelation.relation === 'conflict' && trustAssessment.state !== 'trusted') ||
        conflict?.resolution === 'dispute')
    ) {
      await adapter.updateKnowledgeMemory(strongestRelation.related.id, {
        knowledge_state: 'disputed',
        disputed_at: nowSeconds(),
        dispute_reason: trustAssessment.reasons.join(', ') || 'Contradictory evidence detected',
        contradiction_score: Math.max(strongestRelation.related.contradiction_score, 1),
        trust_score: Math.min(strongestRelation.related.trust_score, trustAssessment.trust_score),
      });
      await adapter.insertKnowledgeMemoryAudit({
        ...normalizedScope,
        working_memory_id: workingMemoryId,
        fact: fact.fact,
        fact_type: fact.factType,
        fact_subject: fact.subject,
        fact_attribute: fact.attribute,
        fact_value: fact.value,
        normalized_fact: fact.normalizedFact,
        slot_key: fact.slotKey,
        is_negated: fact.isNegated,
        confidence: resolvedConfidence,
        confidence_score: trustAssessment.trust_score,
        verification_status: resolvedVerificationStatus,
        source_text: fact.sourceText ?? fact.fact,
        decision: 'conflict',
        related_knowledge_id: strongestRelation.related.id,
        detail: `Marked existing knowledge disputed (${trustAssessment.reasons.join(', ')})`,
      });
      continue;
    }

    if (
      strongestRelation.relation === 'conflict' &&
      policy.conflictStrategy === 'skip' &&
      strongestRelation.related
    ) {
      await adapter.insertKnowledgeMemoryAudit({
        ...normalizedScope,
        working_memory_id: workingMemoryId,
        fact: fact.fact,
        fact_type: fact.factType,
        fact_subject: fact.subject,
        fact_attribute: fact.attribute,
        fact_value: fact.value,
        normalized_fact: fact.normalizedFact,
        slot_key: fact.slotKey,
        is_negated: fact.isNegated,
        confidence: resolvedConfidence,
        confidence_score: resolvedConfidenceScore,
        verification_status: resolvedVerificationStatus,
        source_text: fact.sourceText ?? fact.fact,
        decision: 'conflict',
        related_knowledge_id: strongestRelation.related.id,
        detail: verificationNotes ?? 'Conflict strategy skipped promotion',
      });
      continue;
    }

    const promotionPlan = buildPromotionPersistencePlan({
      normalizedScope,
      workingMemoryId,
      fact,
      candidateInput,
      candidateEvidenceInputs,
      grounded,
      trustAssessment,
      strongestRelation,
      resolvedConfidence,
      resolvedConfidenceScore,
      resolvedVerificationStatus,
      verificationNotes,
      conflict,
      policy,
    });

    const createdFact = await runAtomicStorage(
      adapter,
      () => persistPromotedKnowledgeAsync(adapter, normalizedScope, promotionPlan),
      (syncAdapter) => persistPromotedKnowledgeSync(syncAdapter, normalizedScope, promotionPlan),
    );

    duplicateLookup.set(normalizedFact, createdFact);
    normalizedKnowledge.push({
      memory: createdFact,
      normalized: normalizeKnowledgeMemory(createdFact),
    });
    created.push(createdFact);

    // Auto-detect associations between the new fact and all known knowledge (including batch-created)
    await autoDetectAssociations(adapter, normalizedScope, createdFact, [...activeKnowledge, ...created.slice(0, -1)]);
  }

  // Create associations between alias-resolved facts and the canonical entity's knowledge facts
  if (aliasResolutions.length > 0 && created.length > 0) {
    const allKnowledge = [...activeKnowledge, ...created];
    for (const createdFact of created) {
      const factResolutions = aliasResolutions.filter((r) =>
        createdFact.fact.toLowerCase().includes(r.canonical.toLowerCase()),
      );
      for (const resolution of factResolutions) {
        // Find an existing knowledge fact about the canonical entity
        // Entity facts use fact_subject='entity' with the name in fact_value,
        // while other fact types use fact_subject directly
        const canonicalLower = resolution.canonical.toLowerCase();
        const canonicalFact = allKnowledge.find(
          (k) =>
            k.id !== createdFact.id &&
            (k.fact_subject?.toLowerCase() === canonicalLower ||
             k.fact_value?.toLowerCase() === canonicalLower),
        );
        if (!canonicalFact) continue;
        try {
          await adapter.insertAssociation({
            ...normalizedScope,
            source_kind: 'knowledge',
            source_id: createdFact.id,
            target_kind: 'knowledge',
            target_id: canonicalFact.id,
            association_type: 'alias_resolution',
            provenance: 'inferred',
            confidence: 1.0,
            auto_generated: true,
          });
        } catch (e: unknown) {
          if (e instanceof UniqueConstraintError) continue;
          throw e;
        }
      }
    }
  }

  emitMemoryEvent('extraction', normalizedScope, options, Date.now() - startedAt, {
    workingMemoryId,
    extractedCount: extracted.length,
    createdCount: created.length,
  });

  return created;
}
