import { describe, expect, it } from 'vitest';

import { matchesScopeLevel, type MemoryScope, type ScopeLevel } from '../contracts/identity.js';
import type { ContextViewPolicy } from '../contracts/coordination.js';
import { resolveContextScopeLevel, resolveVisibleKnowledge } from '../core/context.js';
import type { KnowledgeMemory } from '../contracts/types.js';

const baseScope: MemoryScope = {
  tenant_id: 'acme',
  system_id: 'assistant',
  workspace_id: 'factory',
  collaboration_id: 'incident-7',
  scope_id: 'run-a',
};

function makeKnowledge(
  id: number,
  scope: MemoryScope,
  visibilityClass: KnowledgeMemory['visibility_class'],
): KnowledgeMemory {
  return {
    ...scope,
    id,
    visibility_class: visibilityClass,
    fact: `${visibilityClass}-${id}`,
    fact_type: 'reference',
    knowledge_state: 'trusted',
    knowledge_class: 'project_fact',
    fact_subject: null,
    fact_attribute: null,
    fact_value: null,
    normalized_fact: null,
    slot_key: null,
    is_negated: false,
    source: 'manual',
    confidence: 'high',
    confidence_score: 0.9,
    grounding_strength: 'strong',
    evidence_count: 1,
    trust_score: 0.9,
    verification_status: 'corroborated',
    verification_notes: null,
    last_verified_at: null,
    next_reverification_at: null,
    last_confirmed_at: null,
    confirmation_count: 0,
    source_system_id: scope.system_id,
    source_scope_id: scope.scope_id,
    source_collaboration_id: scope.collaboration_id ?? '',
    source_working_memory_id: null,
    source_turn_ids: [],
    successful_use_count: 0,
    failed_use_count: 0,
    disputed_at: null,
    dispute_reason: null,
    contradiction_score: 0,
    superseded_at: null,
    superseded_by_id: null,
    retired_at: null,
    created_at: 100,
    last_accessed_at: 100,
    access_count: 1,
    schema_version: 1,
  };
}

describe('scope semantics', () => {
  it.each([
    {
      level: 'scope' as ScopeLevel,
      item: baseScope,
      expected: true,
      label: 'scope requires an exact scope match',
    },
    {
      level: 'workspace' as ScopeLevel,
      item: { ...baseScope, system_id: 'planner', collaboration_id: '', scope_id: 'run-b' },
      expected: true,
      label: 'workspace spans systems and collaborations inside one workspace',
    },
    {
      level: 'system' as ScopeLevel,
      item: { ...baseScope, workspace_id: 'shared', collaboration_id: '', scope_id: 'run-c' },
      expected: true,
      label: 'system spans workspaces inside one system',
    },
    {
      level: 'tenant' as ScopeLevel,
      item: { ...baseScope, system_id: 'planner', workspace_id: 'shared', scope_id: 'run-d' },
      expected: true,
      label: 'tenant spans the whole tenant boundary',
    },
    {
      level: 'tenant' as ScopeLevel,
      item: { ...baseScope, tenant_id: 'globex' },
      expected: false,
      label: 'tenant rejects records from another tenant',
    },
  ])('$label', ({ item, level, expected }) => {
    expect(matchesScopeLevel(item, baseScope, level)).toBe(expected);
  });

  it.each([
    {
      crossScopeLevel: undefined,
      view: undefined,
      expected: undefined,
    },
    {
      crossScopeLevel: undefined,
      view: 'workspace_shared' as ContextViewPolicy,
      expected: 'workspace',
    },
    {
      crossScopeLevel: undefined,
      view: 'operator_supervisor' as ContextViewPolicy,
      expected: 'tenant',
    },
    {
      crossScopeLevel: 'system' as ScopeLevel,
      view: 'operator_supervisor' as ContextViewPolicy,
      expected: 'system',
    },
    {
      crossScopeLevel: 'workspace' as ScopeLevel,
      view: 'local_only' as ContextViewPolicy,
      expected: 'workspace',
    },
  ])(
    'resolveContextScopeLevel($crossScopeLevel, $view) -> $expected',
    ({ crossScopeLevel, view, expected }) => {
      expect(resolveContextScopeLevel(crossScopeLevel, view)).toBe(expected);
    },
  );

  it('applies the full visibility matrix across context views', () => {
    const knowledge = [
      makeKnowledge(1, baseScope, 'private'),
      makeKnowledge(2, { ...baseScope, scope_id: 'run-b' }, 'shared_collaboration'),
      makeKnowledge(
        3,
        { ...baseScope, system_id: 'planner', collaboration_id: '', scope_id: 'run-c' },
        'workspace',
      ),
      makeKnowledge(
        4,
        { ...baseScope, system_id: 'planner', workspace_id: 'shared', scope_id: 'run-d' },
        'tenant',
      ),
    ];

    const expectations: Record<ContextViewPolicy, KnowledgeMemory['visibility_class'][]> = {
      local_only: ['private'],
      local_plus_shared_collaboration: ['private', 'shared_collaboration'],
      workspace_shared: ['private', 'shared_collaboration', 'workspace'],
      operator_supervisor: ['private', 'shared_collaboration', 'workspace', 'tenant'],
    };

    for (const [view, visibleClasses] of Object.entries(expectations) as Array<
      [ContextViewPolicy, KnowledgeMemory['visibility_class'][]]
    >) {
      expect(
        resolveVisibleKnowledge(knowledge, baseScope, view).map((item) => item.visibility_class),
      ).toEqual(visibleClasses);
    }
  });
});
