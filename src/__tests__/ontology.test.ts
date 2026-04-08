import { describe, expect, it } from 'vitest';

import type { OntologyConfig } from '../contracts/ontology.js';
import type { KnowledgeMemory, Association } from '../contracts/types.js';
import type { NormalizedExtractedFact } from '../core/extractor.js';
import {
  resolveEntityType,
  getDefinedEntityTypes,
  validateFactEntityType,
  validateRelationship,
  validateRules,
  validateFact,
  validateExtractedFacts,
  checkOntologyViolations,
  inferKnowledgeClass,
} from '../core/ontology.js';

function makeFact(overrides: Partial<NormalizedExtractedFact> = {}): NormalizedExtractedFact {
  return {
    fact: 'test fact',
    factType: 'reference',
    confidence: 'high',
    subject: 'user',
    attribute: 'preference',
    value: 'dark mode',
    normalizedFact: 'test fact',
    slotKey: null,
    isNegated: false,
    valid_from: null,
    valid_until: null,
    ...overrides,
  };
}

function makeOntology(overrides: Partial<OntologyConfig> = {}): OntologyConfig {
  return {
    entityTypes: [
      {
        name: 'person',
        description: 'A person entity',
        extendsClass: 'identity',
        allowedRelationships: ['related_to', 'supports'],
      },
      {
        name: 'tool',
        description: 'A tool or technology',
        allowedRelationships: ['related_to', 'depends_on'],
      },
      {
        name: 'project_fact',
        description: 'Project-specific fact',
        extendsClass: 'project_fact',
        allowedRelationships: ['related_to', 'supports', 'contradicts'],
      },
    ],
    relationshipConstraints: [
      {
        sourceType: 'identity',
        targetType: 'tool',
        relationshipType: 'depends_on',
        bidirectional: false,
      },
      {
        sourceType: 'project_fact',
        targetType: 'project_fact',
        relationshipType: 'supports',
        bidirectional: true,
      },
    ],
    validationRules: [],
    ...overrides,
  };
}

function makeKnowledgeMemory(overrides: Partial<KnowledgeMemory> = {}): KnowledgeMemory {
  return {
    id: 1,
    tenant_id: 'acme',
    system_id: 'assistant',
    scope_id: 'thread-1',
    visibility_class: 'scope',
    fact: 'test fact',
    fact_type: 'reference',
    knowledge_state: 'trusted',
    knowledge_class: 'project_fact',
    fact_subject: 'user',
    fact_attribute: 'role',
    fact_value: 'engineer',
    normalized_fact: 'test fact',
    slot_key: null,
    is_negated: false,
    source: 'manual',
    confidence: 'high',
    confidence_score: 0.9,
    grounding_strength: 'strong',
    evidence_count: 1,
    trust_score: 0.85,
    verification_status: 'unverified',
    verification_notes: null,
    last_verified_at: null,
    next_reverification_at: null,
    last_confirmed_at: null,
    confirmation_count: 0,
    source_session_id: null,
    source_collaboration_id: null,
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
    valid_from: null,
    valid_until: null,
    rationale: null,
    tags: [],
    created_at: 1000,
    last_accessed_at: 1000,
    access_count: 0,
    schema_version: 1,
    ...overrides,
  };
}

function makeAssociation(overrides: Partial<Association> = {}): Association {
  return {
    id: 1,
    tenant_id: 'acme',
    system_id: 'assistant',
    scope_id: 'thread-1',
    visibility_class: 'scope',
    source_kind: 'knowledge',
    source_id: 1,
    target_kind: 'knowledge',
    target_id: 2,
    association_type: 'supports',
    provenance: 'extracted',
    confidence: 1.0,
    auto_generated: false,
    created_at: 1000,
    ...overrides,
  };
}

describe('inferKnowledgeClass', () => {
  it('maps fact types to knowledge classes', () => {
    expect(inferKnowledgeClass('entity')).toBe('identity');
    expect(inferKnowledgeClass('preference')).toBe('preference');
    expect(inferKnowledgeClass('constraint')).toBe('constraint');
    expect(inferKnowledgeClass('decision')).toBe('procedure');
    expect(inferKnowledgeClass('reference')).toBe('project_fact');
  });
});

describe('resolveEntityType', () => {
  const config = makeOntology();

  it('finds entity type by name', () => {
    const result = resolveEntityType('person', config);
    expect(result).toBeDefined();
    expect(result!.name).toBe('person');
  });

  it('finds entity type by extendsClass', () => {
    const result = resolveEntityType('identity', config);
    expect(result).toBeDefined();
    expect(result!.name).toBe('person');
  });

  it('returns undefined for unknown type', () => {
    expect(resolveEntityType('unknown', config)).toBeUndefined();
  });
});

describe('getDefinedEntityTypes', () => {
  it('includes both entity names and extended classes', () => {
    const config = makeOntology();
    const types = getDefinedEntityTypes(config);
    expect(types.has('person')).toBe(true);
    expect(types.has('tool')).toBe(true);
    expect(types.has('identity')).toBe(true);
    expect(types.has('project_fact')).toBe(true);
  });
});

describe('validateFactEntityType', () => {
  it('returns no violations for known entity type', () => {
    const config = makeOntology();
    const fact = makeFact({ factType: 'entity' }); // maps to 'identity'
    expect(validateFactEntityType(fact, config)).toHaveLength(0);
  });

  it('returns warning for unknown entity type', () => {
    const config = makeOntology({ entityTypes: [{ name: 'custom', description: 'Custom type', allowedRelationships: [] }] });
    const fact = makeFact({ factType: 'entity' }); // maps to 'identity', not in config
    const violations = validateFactEntityType(fact, config);
    expect(violations).toHaveLength(1);
    expect(violations[0].severity).toBe('warning');
    expect(violations[0].entityType).toBe('identity');
  });

  it('returns empty when no entity types defined', () => {
    const config = makeOntology({ entityTypes: [] });
    expect(validateFactEntityType(makeFact(), config)).toHaveLength(0);
  });
});

describe('validateRelationship', () => {
  const config = makeOntology();

  it('allows permitted relationship', () => {
    const violations = validateRelationship('identity', 'tool', 'depends_on', config);
    expect(violations).toHaveLength(0);
  });

  it('rejects non-permitted relationship', () => {
    const violations = validateRelationship('tool', 'identity', 'depends_on', config);
    expect(violations).toHaveLength(1);
    expect(violations[0].severity).toBe('warning');
  });

  it('allows bidirectional relationship in reverse', () => {
    const violations = validateRelationship('project_fact', 'project_fact', 'supports', config);
    expect(violations).toHaveLength(0);
  });

  it('allows unconstrained relationship types', () => {
    const violations = validateRelationship('anything', 'else', 'related_to', config);
    expect(violations).toHaveLength(0);
  });

  it('returns empty when no constraints defined', () => {
    const config = makeOntology({ relationshipConstraints: [] });
    expect(validateRelationship('a', 'b', 'supports', config)).toHaveLength(0);
  });
});

describe('validateRules', () => {
  it('enforces require_subject rule', () => {
    const config = makeOntology({
      validationRules: [
        { id: 'require_subject', description: 'Subject required', appliesTo: [], severity: 'warning' },
      ],
    });
    const fact = makeFact({ subject: null });
    const violations = validateRules(fact, config);
    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe('require_subject');
  });

  it('enforces require_value rule', () => {
    const config = makeOntology({
      validationRules: [
        { id: 'require_value', description: 'Value required', appliesTo: [], severity: 'error' },
      ],
    });
    const fact = makeFact({ value: null });
    const violations = validateRules(fact, config);
    expect(violations).toHaveLength(1);
    expect(violations[0].severity).toBe('error');
  });

  it('skips rules not applicable to fact type', () => {
    const config = makeOntology({
      validationRules: [
        { id: 'require_subject', description: 'Subject required', appliesTo: ['identity'], severity: 'warning' },
      ],
    });
    // factType 'reference' maps to 'project_fact', not 'identity'
    const fact = makeFact({ factType: 'reference', subject: null });
    expect(validateRules(fact, config)).toHaveLength(0);
  });

  it('passes when rule conditions are met', () => {
    const config = makeOntology({
      validationRules: [
        { id: 'require_subject', description: 'Subject required', appliesTo: [], severity: 'warning' },
      ],
    });
    const fact = makeFact({ subject: 'user' });
    expect(validateRules(fact, config)).toHaveLength(0);
  });
});

describe('validateFact', () => {
  it('combines entity type and rule validation', () => {
    const config = makeOntology({
      validationRules: [
        { id: 'require_subject', description: 'Subject required', appliesTo: [], severity: 'warning' },
      ],
    });
    const fact = makeFact({ subject: null });
    const result = validateFact(fact, config);
    expect(result.valid).toBe(true); // only warnings, no errors
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.errors).toHaveLength(0);
  });

  it('marks invalid when error-level violation exists', () => {
    const config = makeOntology({
      validationRules: [
        { id: 'require_value', description: 'Value required', appliesTo: [], severity: 'error' },
      ],
    });
    const fact = makeFact({ value: null });
    const result = validateFact(fact, config);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
  });
});

describe('validateExtractedFacts', () => {
  it('returns all facts when no ontology config', () => {
    const facts = [makeFact(), makeFact()];
    const result = validateExtractedFacts(facts, undefined);
    expect(result.facts).toHaveLength(2);
    expect(result.violations).toHaveLength(0);
  });

  it('filters facts with error-level violations', () => {
    const config = makeOntology({
      validationRules: [
        { id: 'require_value', description: 'Value required', appliesTo: [], severity: 'error' },
      ],
    });
    const facts = [makeFact({ value: 'ok' }), makeFact({ value: null })];
    const result = validateExtractedFacts(facts, config);
    expect(result.facts).toHaveLength(1);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it('keeps facts with only warning-level violations', () => {
    const config = makeOntology({
      validationRules: [
        { id: 'require_subject', description: 'Subject required', appliesTo: [], severity: 'warning' },
      ],
    });
    const facts = [makeFact({ subject: null })];
    const result = validateExtractedFacts(facts, config);
    expect(result.facts).toHaveLength(1);
    expect(result.violations).toHaveLength(1);
  });
});

describe('checkOntologyViolations', () => {
  it('returns empty when no ontology config', () => {
    const issues = checkOntologyViolations([], [], undefined);
    expect(issues).toHaveLength(0);
  });

  it('flags knowledge with unknown class', () => {
    const config = makeOntology();
    const knowledge = [makeKnowledgeMemory({ knowledge_class: 'unknown_class' as any })];
    const issues = checkOntologyViolations(knowledge, [], config);
    expect(issues).toHaveLength(1);
    expect(issues[0].category).toBe('ontology_violation');
    expect(issues[0].severity).toBe('warning');
  });

  it('does not flag knowledge with known class', () => {
    const config = makeOntology();
    const knowledge = [makeKnowledgeMemory({ knowledge_class: 'identity' })];
    const issues = checkOntologyViolations(knowledge, [], config);
    expect(issues).toHaveLength(0);
  });

  it('flags association violating relationship constraint', () => {
    const config = makeOntology();
    const knowledge = [
      makeKnowledgeMemory({ id: 1, knowledge_class: 'project_fact' }),
      makeKnowledgeMemory({ id: 2, knowledge_class: 'identity' }),
    ];
    // depends_on only allows identity→tool, not project_fact→identity
    const associations = [
      makeAssociation({ source_id: 1, target_id: 2, association_type: 'depends_on' }),
    ];
    const issues = checkOntologyViolations(knowledge, associations, config);
    const relIssues = issues.filter((i) => i.details?.associationType === 'depends_on');
    expect(relIssues).toHaveLength(1);
    expect(relIssues[0].category).toBe('ontology_violation');
  });

  it('does not flag permitted associations', () => {
    const config = makeOntology();
    const knowledge = [
      makeKnowledgeMemory({ id: 1, knowledge_class: 'project_fact' }),
      makeKnowledgeMemory({ id: 2, knowledge_class: 'project_fact' }),
    ];
    const associations = [
      makeAssociation({ source_id: 1, target_id: 2, association_type: 'supports' }),
    ];
    const issues = checkOntologyViolations(knowledge, associations, config);
    expect(issues).toHaveLength(0);
  });

  it('checks validation rules against existing knowledge', () => {
    const config = makeOntology({
      validationRules: [
        { id: 'require_subject', description: 'Subject required', appliesTo: ['project_fact'], severity: 'warning' },
      ],
    });
    const knowledge = [makeKnowledgeMemory({ fact_subject: null })];
    const issues = checkOntologyViolations(knowledge, [], config);
    expect(issues.some((i) => i.details?.ruleId === 'require_subject')).toBe(true);
  });

  it('system works without ontology config', () => {
    // All validation functions handle undefined/empty gracefully
    const config = makeOntology({ entityTypes: [], relationshipConstraints: [], validationRules: [] });
    const knowledge = [makeKnowledgeMemory()];
    const issues = checkOntologyViolations(knowledge, [], config);
    expect(issues).toHaveLength(0);
  });
});
