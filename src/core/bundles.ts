import type { MemoryScope } from '../contracts/identity.js';
import type { StorageAdapter } from '../contracts/storage.js';
import type {
  KnowledgeMemory,
  Playbook,
  NewKnowledgeMemory,
  NewPlaybook,
} from '../contracts/types.js';
import type {
  MemoryBundle,
  BundleExportOptions,
  BundleImportOptions,
  BundleConflictResolution,
} from '../contracts/bundles.js';

const BUNDLE_VERSION = '1.0.0';

export interface ExportBundleResult {
  bundle: MemoryBundle;
  factCount: number;
  playbookCount: number;
}

export interface ImportBundleResult {
  imported: number;
  skipped: number;
  overwritten: number;
  merged: number;
  playbooksImported: number;
  playbooksSkipped: number;
}

function matchesTags(item: { tags: string[] }, includeTags: string[]): boolean {
  return includeTags.some((tag) => item.tags.includes(tag));
}

/**
 * Export a named, versioned bundle of knowledge facts and playbooks
 * from a given scope, optionally filtered by tags and knowledge class.
 */
export function exportBundle(
  adapter: StorageAdapter,
  name: string,
  options: BundleExportOptions,
): ExportBundleResult {
  let facts = adapter.getActiveKnowledgeMemory(options.scope);

  if (options.knowledgeClassFilter && options.knowledgeClassFilter.length > 0) {
    const allowedClasses = new Set(options.knowledgeClassFilter);
    facts = facts.filter((f) => allowedClasses.has(f.knowledge_class));
  }

  if (options.includeTags && options.includeTags.length > 0) {
    facts = facts.filter((f) => matchesTags(f, options.includeTags!));
  }

  let playbooks = adapter.getActivePlaybooks(options.scope);
  if (options.includeTags && options.includeTags.length > 0) {
    playbooks = playbooks.filter((p) => matchesTags(p, options.includeTags!));
  }

  const bundle: MemoryBundle = {
    name,
    version: BUNDLE_VERSION,
    facts,
    playbooks,
    metadata: {
      sourceScope: options.scope,
      knowledgeClassFilter: options.knowledgeClassFilter ?? null,
      includeTags: options.includeTags ?? null,
    },
    exportedAt: new Date().toISOString(),
  };

  return {
    bundle,
    factCount: facts.length,
    playbookCount: playbooks.length,
  };
}

function findConflictingFact(
  existing: KnowledgeMemory[],
  incoming: KnowledgeMemory,
): KnowledgeMemory | null {
  // Match on normalized_fact or slot_key for deduplication
  if (incoming.slot_key) {
    const match = existing.find(
      (e) =>
        e.slot_key === incoming.slot_key && e.knowledge_class === incoming.knowledge_class,
    );
    if (match) return match;
  }
  if (incoming.normalized_fact) {
    const match = existing.find((e) => e.normalized_fact === incoming.normalized_fact);
    if (match) return match;
  }
  return null;
}

function resolveFactConflict(
  resolution: BundleConflictResolution,
  existing: KnowledgeMemory,
  incoming: KnowledgeMemory,
): 'skip' | 'overwrite' | 'merge' {
  switch (resolution) {
    case 'skip':
      return 'skip';
    case 'overwrite':
      return 'overwrite';
    case 'merge':
      return 'merge';
    case 'trust_higher':
      return incoming.trust_score > existing.trust_score ? 'overwrite' : 'skip';
  }
}

function toNewKnowledgeMemory(
  km: KnowledgeMemory,
  targetScope: MemoryScope,
  preserveTrust: boolean,
): NewKnowledgeMemory {
  return {
    ...targetScope,
    fact: km.fact,
    fact_type: km.fact_type,
    knowledge_class: km.knowledge_class,
    fact_subject: km.fact_subject,
    fact_attribute: km.fact_attribute,
    fact_value: km.fact_value,
    normalized_fact: km.normalized_fact,
    slot_key: km.slot_key,
    is_negated: km.is_negated,
    source: km.source,
    confidence: km.confidence,
    confidence_score: preserveTrust ? km.confidence_score : km.confidence_score,
    trust_score: preserveTrust ? km.trust_score : undefined,
    knowledge_state: preserveTrust ? km.knowledge_state : 'provisional',
    grounding_strength: km.grounding_strength,
    valid_from: km.valid_from,
    valid_until: km.valid_until,
    rationale: km.rationale,
    tags: km.tags,
  };
}

function toNewPlaybook(pb: Playbook, targetScope: MemoryScope): NewPlaybook {
  return {
    ...targetScope,
    title: pb.title,
    description: pb.description,
    instructions: pb.instructions,
    references: pb.references,
    templates: pb.templates,
    scripts: pb.scripts,
    assets: pb.assets,
    tags: pb.tags,
    rationale: pb.rationale,
    status: pb.status,
  };
}

/**
 * Import a bundle into a target scope, resolving conflicts using the
 * specified strategy. Facts that conflict with existing knowledge are
 * handled according to the trust pipeline via the conflict resolution mode.
 */
export function importBundle(
  adapter: StorageAdapter,
  bundle: MemoryBundle,
  options: BundleImportOptions,
): ImportBundleResult {
  let existing = adapter.getActiveKnowledgeMemory(options.targetScope);
  const preserveTrust = options.preserveTrust ?? false;

  let imported = 0;
  let skipped = 0;
  let overwritten = 0;
  let merged = 0;

  for (const fact of bundle.facts) {
    const conflict = findConflictingFact(existing, fact);

    if (!conflict) {
      adapter.insertKnowledgeMemory(
        toNewKnowledgeMemory(fact, options.targetScope, preserveTrust),
      );
      imported++;
      // Refresh existing to detect conflicts with later bundle facts
      existing = adapter.getActiveKnowledgeMemory(options.targetScope);
      continue;
    }

    const action = resolveFactConflict(options.conflictResolution, conflict, fact);

    switch (action) {
      case 'skip':
        skipped++;
        break;
      case 'overwrite':
        // Retire the existing fact (sets retired_at so queries filter it out) and insert the incoming one
        adapter.retireKnowledgeMemory(conflict.id);
        adapter.insertKnowledgeMemory(
          toNewKnowledgeMemory(fact, options.targetScope, preserveTrust),
        );
        overwritten++;
        // Refresh existing after mutation
        existing = adapter.getActiveKnowledgeMemory(options.targetScope);
        break;
      case 'merge': {
        // Merge: adopt the higher trust score from incoming
        const mergedTrustScore = Math.max(conflict.trust_score, fact.trust_score);
        adapter.updateKnowledgeMemory(conflict.id, {
          trust_score: mergedTrustScore,
        });
        merged++;
        // Refresh existing so subsequent merges compare against updated trust scores
        existing = adapter.getActiveKnowledgeMemory(options.targetScope);
        break;
      }
    }
  }

  // Import playbooks — skip duplicates by title
  const existingPlaybooks = adapter.getActivePlaybooks(options.targetScope);
  const existingTitles = new Set(existingPlaybooks.map((p) => p.title));

  let playbooksImported = 0;
  let playbooksSkipped = 0;

  for (const pb of bundle.playbooks) {
    if (existingTitles.has(pb.title)) {
      playbooksSkipped++;
    } else {
      adapter.insertPlaybook(toNewPlaybook(pb, options.targetScope));
      existingTitles.add(pb.title);
      playbooksImported++;
    }
  }

  return { imported, skipped, overwritten, merged, playbooksImported, playbooksSkipped };
}
