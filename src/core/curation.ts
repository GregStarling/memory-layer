import type {
  CurationAction,
  CurationSummary,
  CurationOptions,
  CurationActionType,
} from '../contracts/curation.js';
import type { KnowledgeReflectionResult } from '../contracts/reflection.js';
import type { DerivedOutput } from '../contracts/derived.js';
import type { MaintenanceReport } from './maintenance.js';
import { nowSeconds } from './validation.js';

/**
 * Input sources for the curation summary. All fields are optional so the
 * summary is useful even before reflection, ontology, or derivation are
 * enabled (maintenance-only mode).
 */
export interface CurationInput {
  /** Most recent maintenance report. */
  maintenance?: MaintenanceReport;
  /** Timestamp when maintenance ran (epoch seconds). */
  maintenanceTimestamp?: number;
  /** Most recent reflection result. */
  reflection?: KnowledgeReflectionResult;
  /** Timestamp when reflection ran (epoch seconds). */
  reflectionTimestamp?: number;
  /** Derived outputs produced since last curation. */
  derived?: DerivedOutput[];
  /** Timestamp when derivation ran (epoch seconds). */
  derivedTimestamp?: number;
  /** Ontology merge/alias actions performed since last curation. */
  ontologyActions?: CurationAction[];
}

// --- Maintenance → CurationAction conversion ---

function maintenanceActions(
  report: MaintenanceReport,
  timestamp: number,
): CurationAction[] {
  const actions: CurationAction[] = [];

  if (report.retiredKnowledgeIds.length > 0) {
    actions.push({
      actionType: 'retired',
      affectedEntities: report.retiredKnowledgeIds.map((id) => `knowledge:${id}`),
      explanation: `Retired ${report.retiredKnowledgeIds.length} knowledge fact(s) during maintenance.`,
      timestamp,
      source: 'maintenance',
    });
  }

  if (report.expiredWorkingMemoryIds.length > 0) {
    actions.push({
      actionType: 'expired',
      affectedEntities: report.expiredWorkingMemoryIds.map((id) => `working_memory:${id}`),
      explanation: `Expired ${report.expiredWorkingMemoryIds.length} working memory item(s).`,
      timestamp,
      source: 'maintenance',
    });
  }

  if (report.expiredCandidateIds.length > 0) {
    actions.push({
      actionType: 'expired',
      affectedEntities: report.expiredCandidateIds.map((id) => `candidate:${id}`),
      explanation: `Expired ${report.expiredCandidateIds.length} stale knowledge candidate(s).`,
      timestamp,
      source: 'maintenance',
    });
  }

  if (report.demotedKnowledgeIds.length > 0) {
    actions.push({
      actionType: 'demoted',
      affectedEntities: report.demotedKnowledgeIds.map((id) => `knowledge:${id}`),
      explanation: `Demoted ${report.demotedKnowledgeIds.length} knowledge fact(s) to provisional.`,
      timestamp,
      source: 'maintenance',
    });
  }

  if (report.deletedWorkItemIds.length > 0) {
    actions.push({
      actionType: 'expired',
      affectedEntities: report.deletedWorkItemIds.map((id) => `work_item:${id}`),
      explanation: `Deleted ${report.deletedWorkItemIds.length} completed/stale work item(s).`,
      timestamp,
      source: 'maintenance',
    });
  }

  if (report.deletedAssociationIds.length > 0) {
    actions.push({
      actionType: 'expired',
      affectedEntities: report.deletedAssociationIds.map((id) => `association:${id}`),
      explanation: `Deleted ${report.deletedAssociationIds.length} orphaned association(s).`,
      timestamp,
      source: 'maintenance',
    });
  }

  if (report.reverifiedKnowledgeIds.length > 0) {
    actions.push({
      actionType: 'reverified',
      affectedEntities: report.reverifiedKnowledgeIds.map((id) => `knowledge:${id}`),
      explanation: `Re-verified ${report.reverifiedKnowledgeIds.length} knowledge fact(s) during maintenance.`,
      timestamp,
      source: 'maintenance',
    });
  }

  return actions;
}

// --- Reflection → CurationAction conversion ---

function reflectionActions(
  result: KnowledgeReflectionResult,
  timestamp: number,
): CurationAction[] {
  const actions: CurationAction[] = [];

  if (result.newFacts.length > 0) {
    actions.push({
      actionType: 'reflected',
      affectedEntities: result.newFacts.map((f) => f.fact),
      explanation: `Reflection produced ${result.newFacts.length} new provisional fact(s) from ${result.sessionsAnalyzed} session(s).`,
      timestamp,
      source: 'reflection',
    });
  }

  if (result.patternsFound.length > 0) {
    actions.push({
      actionType: 'reflected',
      affectedEntities: result.patternsFound.map((p) => p.name),
      explanation: `Detected ${result.patternsFound.length} recurring pattern(s) across knowledge base.`,
      timestamp,
      source: 'reflection',
    });
  }

  if (result.aliasCandidates && result.aliasCandidates.length > 0) {
    actions.push({
      actionType: 'merged',
      affectedEntities: result.aliasCandidates.map(
        (c) => `${c.entity1} ↔ ${c.entity2}`,
      ),
      explanation: `Discovered ${result.aliasCandidates.length} potential alias pair(s) for operator confirmation.`,
      timestamp,
      source: 'reflection',
    });
  }

  return actions;
}

// --- Derived → CurationAction conversion ---

function derivedActions(
  outputs: DerivedOutput[],
  timestamp: number,
): CurationAction[] {
  if (outputs.length === 0) return [];

  // Group by type for compact representation
  const byType = new Map<string, DerivedOutput[]>();
  for (const output of outputs) {
    const list = byType.get(output.type) ?? [];
    list.push(output);
    byType.set(output.type, list);
  }

  const actions: CurationAction[] = [];
  for (const [type, items] of byType) {
    actions.push({
      actionType: 'derived',
      affectedEntities: items.map((o) => o.content.split('\n')[0]),
      explanation: `Derived ${items.length} ${type.replace(/_/g, ' ')} candidate(s) for confirmation.`,
      timestamp,
      source: 'derived_pipeline',
    });
  }

  return actions;
}

/**
 * Aggregate recent curation actions from maintenance, reflection, ontology,
 * and derived pipeline sources into a structured timeline.
 *
 * Does not duplicate MaintenanceReport — converts it into CurationAction
 * entries and references the original via maintenanceRef. Works in
 * maintenance-only mode when other sources are not yet enabled.
 */
export function getCurationSummary(
  input: CurationInput,
  options: CurationOptions = {},
): CurationSummary {
  const now = nowSeconds();
  const since = options.since ?? 0;
  const limit = options.limit ?? 100;
  const typeFilter = options.actionTypes
    ? new Set<CurationActionType>(options.actionTypes)
    : null;

  const allActions: CurationAction[] = [];

  // Maintenance actions
  if (input.maintenance) {
    const ts = input.maintenanceTimestamp ?? now;
    allActions.push(...maintenanceActions(input.maintenance, ts));
  }

  // Reflection actions
  if (input.reflection) {
    const ts = input.reflectionTimestamp ?? now;
    allActions.push(...reflectionActions(input.reflection, ts));
  }

  // Derived actions
  if (input.derived && input.derived.length > 0) {
    const ts = input.derivedTimestamp ?? now;
    allActions.push(...derivedActions(input.derived, ts));
  }

  // Ontology actions (already in CurationAction format)
  if (input.ontologyActions) {
    allActions.push(...input.ontologyActions);
  }

  // Apply filters
  let filtered = allActions.filter((a) => a.timestamp >= since);
  if (typeFilter) {
    filtered = filtered.filter((a) => typeFilter.has(a.actionType));
  }

  // Sort by timestamp descending (most recent first)
  filtered.sort((a, b) => b.timestamp - a.timestamp);

  // Apply limit
  const actions = filtered.slice(0, limit);

  // Compute period
  const timestamps = actions.map((a) => a.timestamp);
  const period = {
    start: timestamps.length > 0 ? Math.min(...timestamps) : since || now,
    end: timestamps.length > 0 ? Math.max(...timestamps) : now,
  };

  return {
    actions,
    period,
    maintenanceRef: input.maintenance ? 'MaintenanceReport' : undefined,
    reflectionRef: input.reflection ? 'KnowledgeReflectionResult' : undefined,
  };
}
