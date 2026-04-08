import type { MemoryScope } from '../contracts/identity.js';
import type { StorageAdapter } from '../contracts/storage.js';
import type { KnowledgeMemory } from '../contracts/types.js';
import type {
  KnowledgeReflectionResult,
  ReflectionFact,
  ReflectionPattern,
} from '../contracts/reflection.js';
import type { BuiltInDerivedOutputType, DerivedOutput, DerivedOutputType, DeriveOptions } from '../contracts/derived.js';

/**
 * Registry of derivation handlers. Each handler inspects reflection results
 * and active knowledge to produce typed draft outputs. Custom handlers can
 * be registered to extend the pipeline with new derivation types.
 */
export type DerivationHandler = (input: DerivationInput) => DerivedOutput[];

export interface DerivationInput {
  reflectionResult: KnowledgeReflectionResult;
  activeKnowledge: KnowledgeMemory[];
}

// --- Built-in derivation handlers ---

function derivePlaybookCandidates(input: DerivationInput): DerivedOutput[] {
  const outputs: DerivedOutput[] = [];
  const { reflectionResult, activeKnowledge } = input;

  // Look for recurring patterns with enough occurrences to suggest a workflow
  for (const pattern of reflectionResult.patternsFound) {
    if (pattern.occurrences < 3) continue;

    // Gather the related facts from the reflection
    const relatedFacts = pattern.relatedFactIndices
      .filter((i) => i < reflectionResult.newFacts.length)
      .map((i) => reflectionResult.newFacts[i]);

    const sourceIds = collectSourceIds(relatedFacts, reflectionResult.sourceMemoryIds);

    outputs.push({
      type: 'playbook_candidate',
      content: `Playbook: ${pattern.name}\n${pattern.description}\nSteps derived from ${pattern.occurrences} recurring observations.`,
      confidence: Math.min(0.8, 0.3 + pattern.occurrences * 0.1),
      sourceKnowledgeIds: sourceIds,
      rationale: `Pattern "${pattern.name}" recurs ${pattern.occurrences} times across knowledge base, suggesting a repeatable workflow.`,
    });
  }

  // Also look for clusters of procedure-class knowledge (decisions that form a workflow)
  const procedures = activeKnowledge.filter(
    (km) => km.knowledge_class === 'procedure' && km.knowledge_state === 'trusted',
  );
  if (procedures.length >= 3) {
    // Group by subject
    const bySubject = groupBySubject(procedures);
    for (const [subject, items] of bySubject) {
      if (items.length < 3) continue;
      outputs.push({
        type: 'playbook_candidate',
        content: `Playbook: ${subject} workflow\n${items.map((km) => `- ${km.fact}`).join('\n')}`,
        confidence: Math.min(0.8, 0.3 + items.length * 0.1),
        sourceKnowledgeIds: items.map((km) => km.id),
        rationale: `${items.length} trusted procedure facts about "${subject}" form a potential workflow.`,
      });
    }
  }

  return outputs;
}

function deriveCodingRules(input: DerivationInput): DerivedOutput[] {
  const outputs: DerivedOutput[] = [];
  const { activeKnowledge } = input;

  // Constraints that are trusted and corroborated make strong coding rule candidates
  const constraints = activeKnowledge.filter(
    (km) =>
      km.knowledge_class === 'constraint' &&
      km.knowledge_state === 'trusted' &&
      km.evidence_count >= 2,
  );

  // Group related constraints by subject
  const bySubject = groupBySubject(constraints);
  for (const [subject, items] of bySubject) {
    if (items.length < 2) continue;
    outputs.push({
      type: 'coding_rule',
      content: `Rule: ${subject}\n${items.map((km) => `- ${km.fact}`).join('\n')}`,
      confidence: Math.min(0.85, 0.4 + items.length * 0.1),
      sourceKnowledgeIds: items.map((km) => km.id),
      rationale: `${items.length} corroborated constraints about "${subject}" suggest a codifiable rule.`,
    });
  }

  // Individual high-confidence constraints also qualify
  for (const km of constraints) {
    if (km.trust_score >= 0.8 && km.evidence_count >= 3) {
      outputs.push({
        type: 'coding_rule',
        content: km.fact,
        confidence: Math.min(0.9, km.trust_score),
        sourceKnowledgeIds: [km.id],
        rationale: `Highly trusted constraint (trust=${km.trust_score.toFixed(2)}, evidence=${km.evidence_count}) suitable as a coding rule.`,
      });
    }
  }

  return outputs;
}

function deriveAntiPatterns(input: DerivationInput): DerivedOutput[] {
  const outputs: DerivedOutput[] = [];
  const { activeKnowledge } = input;

  // Negated constraints and disputed facts suggest anti-patterns
  const negatedConstraints = activeKnowledge.filter(
    (km) => km.is_negated && km.knowledge_class === 'constraint' && km.knowledge_state === 'trusted',
  );

  for (const km of negatedConstraints) {
    outputs.push({
      type: 'anti_pattern',
      content: km.fact,
      confidence: Math.min(0.8, km.trust_score),
      sourceKnowledgeIds: [km.id],
      rationale: `Negated constraint indicates a known anti-pattern to avoid.`,
    });
  }

  // Disputed knowledge with high contradiction scores
  const disputed = activeKnowledge.filter(
    (km) => km.knowledge_state === 'disputed' && km.contradiction_score > 0.5,
  );

  for (const km of disputed) {
    outputs.push({
      type: 'anti_pattern',
      content: `Disputed: ${km.fact}${km.dispute_reason ? ` (${km.dispute_reason})` : ''}`,
      confidence: Math.min(0.7, km.contradiction_score),
      sourceKnowledgeIds: [km.id],
      rationale: `High contradiction score (${km.contradiction_score.toFixed(2)}) indicates a pattern that has caused problems.`,
    });
  }

  return outputs;
}

function deriveProjectSummaries(input: DerivationInput): DerivedOutput[] {
  const outputs: DerivedOutput[] = [];
  const { activeKnowledge } = input;

  // Hub facts: trusted knowledge with high evidence counts across multiple classes
  const trustedFacts = activeKnowledge.filter(
    (km) => km.knowledge_state === 'trusted' && km.trust_score >= 0.7,
  );

  if (trustedFacts.length < 3) return outputs;

  // Group by knowledge class for a structured summary
  const byClass = new Map<string, KnowledgeMemory[]>();
  for (const km of trustedFacts) {
    const list = byClass.get(km.knowledge_class) ?? [];
    list.push(km);
    byClass.set(km.knowledge_class, list);
  }

  const summaryParts: string[] = [];
  for (const [cls, items] of [...byClass.entries()].sort()) {
    const topItems = items
      .sort((a, b) => b.trust_score - a.trust_score)
      .slice(0, 5);
    summaryParts.push(`${cls}:\n${topItems.map((km) => `  - ${km.fact}`).join('\n')}`);
  }

  outputs.push({
    type: 'project_summary',
    content: summaryParts.join('\n'),
    confidence: Math.min(0.85, 0.5 + trustedFacts.length * 0.02),
    sourceKnowledgeIds: trustedFacts.slice(0, 20).map((km) => km.id),
    rationale: `Summary derived from ${trustedFacts.length} trusted facts across ${byClass.size} knowledge classes.`,
  });

  return outputs;
}

// --- Handler registry ---

const builtInHandlers: Record<BuiltInDerivedOutputType, DerivationHandler> = {
  playbook_candidate: derivePlaybookCandidates,
  coding_rule: deriveCodingRules,
  anti_pattern: deriveAntiPatterns,
  project_summary: deriveProjectSummaries,
};

const customHandlers = new Map<string, DerivationHandler>();

/**
 * Register a custom derivation handler. The type string can be a built-in
 * type (to override) or a new custom type for extensibility.
 */
export function registerDerivationHandler(type: string, handler: DerivationHandler): void {
  customHandlers.set(type, handler);
}

/**
 * Remove a previously registered custom derivation handler.
 */
export function unregisterDerivationHandler(type: string): void {
  customHandlers.delete(type);
}

/**
 * Reset all custom derivation handlers (for testing).
 */
export function resetDerivationHandlers(): void {
  customHandlers.clear();
}

/**
 * Options for materializing derived outputs into the trust pipeline.
 */
export interface MaterializeOptions {
  adapter: StorageAdapter;
  scope: MemoryScope;
}

/**
 * Produce typed draft outputs from reflection results and active knowledge.
 *
 * Each output is a candidate requiring confirmation before trust pipeline
 * promotion. The derive() function is clearly separated from the reflection
 * pass: reflection discovers patterns and facts, derivation materializes
 * them into actionable outputs.
 *
 * When `materialize` is provided, outputs are inserted into the storage
 * adapter as candidate-state knowledge facts, entering the trust pipeline
 * for downstream confirmation or rejection.
 */
export function derive(
  reflectionResult: KnowledgeReflectionResult,
  activeKnowledge: KnowledgeMemory[],
  options?: Pick<DeriveOptions, 'outputTypes' | 'maxOutputs'>,
  materialize?: MaterializeOptions,
): DerivedOutput[] {
  const outputTypes = options?.outputTypes ?? (['playbook_candidate', 'coding_rule', 'anti_pattern', 'project_summary'] as DerivedOutputType[]);
  const maxOutputs = options?.maxOutputs ?? 20;

  const input: DerivationInput = { reflectionResult, activeKnowledge };
  const allOutputs: DerivedOutput[] = [];

  for (const type of outputTypes) {
    // Custom handlers take precedence over built-in
    const handler = customHandlers.get(type) ?? builtInHandlers[type as BuiltInDerivedOutputType];
    if (!handler) continue;
    allOutputs.push(...handler(input));
  }

  // Sort by confidence descending, cap at maxOutputs
  allOutputs.sort((a, b) => b.confidence - a.confidence);
  const results = allOutputs.slice(0, maxOutputs);

  // Materialize into trust pipeline as candidates when adapter is provided.
  // Derivation type and source provenance are preserved via fact_subject
  // (derivation type) and source_turn_ids (source knowledge IDs) so the
  // candidate remains identifiable after insertion.
  if (materialize) {
    for (const output of results) {
      materialize.adapter.insertKnowledgeMemory({
        ...materialize.scope,
        fact: output.content,
        fact_type: 'entity',
        knowledge_class: 'project_fact',
        knowledge_state: 'candidate',
        source: 'manual',
        confidence: output.confidence >= 0.7 ? 'high' : 'medium',
        confidence_score: output.confidence,
        trust_score: 0,
        rationale: output.rationale,
        fact_subject: `derived:${output.type}`,
        source_turn_ids: output.sourceKnowledgeIds,
        tags: [`derived:${output.type}`],
      });
    }
  }

  return results;
}

// --- Helpers ---

function groupBySubject(knowledge: KnowledgeMemory[]): Map<string, KnowledgeMemory[]> {
  const groups = new Map<string, KnowledgeMemory[]>();
  for (const km of knowledge) {
    const subject = km.fact_subject ?? 'general';
    const list = groups.get(subject) ?? [];
    list.push(km);
    groups.set(subject, list);
  }
  return groups;
}

function collectSourceIds(facts: ReflectionFact[], fallbackIds: number[]): number[] {
  const ids = new Set<number>();
  for (const fact of facts) {
    for (const id of fact.sourceMemoryIds) {
      ids.add(id);
    }
  }
  if (ids.size === 0) {
    for (const id of fallbackIds.slice(0, 10)) {
      ids.add(id);
    }
  }
  return [...ids];
}
