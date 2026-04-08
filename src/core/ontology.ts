import type {
  OntologyConfig,
  EntityTypeDefinition,
} from '../contracts/ontology.js';
import type { FactType, KnowledgeClass, KnowledgeMemory, Association } from '../contracts/types.js';
import type { LintCategory, LintIssue } from '../contracts/lint.js';
import type { NormalizedExtractedFact } from './extractor.js';

const ONTOLOGY_VIOLATION: LintCategory = 'ontology_violation';

/**
 * Result of validating a knowledge fact against ontology constraints.
 */
export interface OntologyValidationResult {
  valid: boolean;
  warnings: OntologyViolation[];
  errors: OntologyViolation[];
}

export interface OntologyViolation {
  ruleId: string | null;
  message: string;
  severity: 'warning' | 'error';
  entityType?: string;
  relationshipType?: string;
}

/**
 * Look up the entity type definition for a knowledge class.
 * Returns the matching EntityTypeDefinition if found, or undefined.
 */
export function resolveEntityType(
  knowledgeClass: KnowledgeClass | string,
  config: OntologyConfig,
): EntityTypeDefinition | undefined {
  return config.entityTypes.find(
    (et) => et.name === knowledgeClass || et.extendsClass === knowledgeClass,
  );
}

/**
 * Get all entity type names defined in the ontology, including built-in classes
 * that are extended by entity type definitions.
 */
export function getDefinedEntityTypes(config: OntologyConfig): Set<string> {
  const types = new Set<string>();
  for (const et of config.entityTypes) {
    types.add(et.name);
    if (et.extendsClass) {
      types.add(et.extendsClass);
    }
  }
  return types;
}

/**
 * Derive the knowledge class from a fact type, matching the orchestrator's mapping.
 */
export function inferKnowledgeClass(factType: FactType): KnowledgeClass {
  if (factType === 'entity') return 'identity';
  if (factType === 'preference') return 'preference';
  if (factType === 'constraint') return 'constraint';
  if (factType === 'decision') return 'procedure';
  return 'project_fact';
}

/**
 * Validate an extracted fact against ontology entity type definitions.
 * Returns warnings for facts whose inferred knowledge_class doesn't match any defined entity type.
 */
export function validateFactEntityType(
  fact: NormalizedExtractedFact,
  config: OntologyConfig,
): OntologyViolation[] {
  if (config.entityTypes.length === 0) return [];

  const definedTypes = getDefinedEntityTypes(config);
  const factClass = inferKnowledgeClass(fact.factType);

  if (!definedTypes.has(factClass)) {
    return [
      {
        ruleId: null,
        message: `Knowledge class '${factClass}' (from fact type '${fact.factType}') is not defined in the ontology`,
        severity: 'warning',
        entityType: factClass,
      },
    ];
  }

  return [];
}

/**
 * Validate a relationship (association) against ontology constraints.
 * Checks that the source and target entity types are allowed for the given
 * relationship type.
 */
export function validateRelationship(
  sourceClass: string,
  targetClass: string,
  relationshipType: string,
  config: OntologyConfig,
): OntologyViolation[] {
  if (config.relationshipConstraints.length === 0) return [];

  // Find constraints for this relationship type
  const applicableConstraints = config.relationshipConstraints.filter(
    (rc) => rc.relationshipType === relationshipType,
  );

  // No constraints for this relationship type — allow it
  if (applicableConstraints.length === 0) return [];

  // Check if any constraint permits this source→target combination
  const permitted = applicableConstraints.some((rc) => {
    const forwardMatch = rc.sourceType === sourceClass && rc.targetType === targetClass;
    const reverseMatch =
      rc.bidirectional && rc.sourceType === targetClass && rc.targetType === sourceClass;
    return forwardMatch || reverseMatch;
  });

  if (!permitted) {
    return [
      {
        ruleId: null,
        message: `Relationship '${relationshipType}' between '${sourceClass}' and '${targetClass}' violates ontology constraints`,
        severity: 'warning',
        entityType: sourceClass,
        relationshipType,
      },
    ];
  }

  return [];
}

/**
 * Validate a fact against ontology validation rules.
 */
export function validateRules(
  fact: NormalizedExtractedFact,
  config: OntologyConfig,
): OntologyViolation[] {
  if (config.validationRules.length === 0) return [];

  const violations: OntologyViolation[] = [];
  const factClass = inferKnowledgeClass(fact.factType);

  for (const rule of config.validationRules) {
    // Skip rules that don't apply to this entity type
    if (rule.appliesTo.length > 0 && !rule.appliesTo.includes(factClass)) {
      continue;
    }

    // Rule-based validations: check structural requirements
    if (rule.id === 'require_subject' && !fact.subject) {
      violations.push({
        ruleId: rule.id,
        message: `${rule.description}: fact is missing a subject`,
        severity: rule.severity,
        entityType: factClass || undefined,
      });
    }

    if (rule.id === 'require_attribute' && !fact.attribute) {
      violations.push({
        ruleId: rule.id,
        message: `${rule.description}: fact is missing an attribute`,
        severity: rule.severity,
        entityType: factClass || undefined,
      });
    }

    if (rule.id === 'require_value' && !fact.value) {
      violations.push({
        ruleId: rule.id,
        message: `${rule.description}: fact is missing a value`,
        severity: rule.severity,
        entityType: factClass || undefined,
      });
    }
  }

  return violations;
}

/**
 * Full validation of an extracted fact against all ontology constraints.
 */
export function validateFact(
  fact: NormalizedExtractedFact,
  config: OntologyConfig,
): OntologyValidationResult {
  const allViolations = [
    ...validateFactEntityType(fact, config),
    ...validateRules(fact, config),
  ];

  return {
    valid: allViolations.filter((v) => v.severity === 'error').length === 0,
    warnings: allViolations.filter((v) => v.severity === 'warning'),
    errors: allViolations.filter((v) => v.severity === 'error'),
  };
}

/**
 * Validate extracted facts against ontology and return violations.
 * Facts with error-level violations are filtered out.
 * Facts with warning-level violations pass through with warnings collected.
 */
export function validateExtractedFacts(
  facts: NormalizedExtractedFact[],
  config: OntologyConfig | undefined,
): { facts: NormalizedExtractedFact[]; violations: OntologyViolation[] } {
  if (!config) return { facts, violations: [] };

  const allViolations: OntologyViolation[] = [];
  const validFacts: NormalizedExtractedFact[] = [];

  for (const fact of facts) {
    const result = validateFact(fact, config);
    allViolations.push(...result.warnings, ...result.errors);
    if (result.valid) {
      validFacts.push(fact);
    }
  }

  return { facts: validFacts, violations: allViolations };
}

/**
 * Check existing knowledge and associations against ontology constraints
 * and return lint issues for violations. Used by the lint system to surface
 * ontology problems in lint reports.
 */
export function checkOntologyViolations(
  knowledge: KnowledgeMemory[],
  associations: Association[],
  config: OntologyConfig | undefined,
): LintIssue[] {
  if (!config) return [];

  const issues: LintIssue[] = [];
  const definedTypes = getDefinedEntityTypes(config);

  // Check knowledge facts against entity type definitions
  if (config.entityTypes.length > 0) {
    for (const k of knowledge) {
      if (!definedTypes.has(k.knowledge_class)) {
        issues.push({
          severity: 'warning',
          category: ONTOLOGY_VIOLATION,
          message: `Knowledge #${k.id} has class '${k.knowledge_class}' which is not defined in the ontology`,
          knowledgeIds: [k.id],
          details: {
            fact: k.fact,
            knowledgeClass: k.knowledge_class,
          },
        });
      }
    }
  }

  // Check associations against relationship constraints
  if (config.relationshipConstraints.length > 0) {
    const knowledgeById = new Map(knowledge.map((k) => [k.id, k]));

    for (const assoc of associations) {
      if (assoc.source_kind !== 'knowledge' || assoc.target_kind !== 'knowledge') continue;

      const source = knowledgeById.get(assoc.source_id);
      const target = knowledgeById.get(assoc.target_id);
      if (!source || !target) continue;

      const violations = validateRelationship(
        source.knowledge_class,
        target.knowledge_class,
        assoc.association_type,
        config,
      );

      for (const v of violations) {
        issues.push({
          severity: 'warning',
          category: ONTOLOGY_VIOLATION,
          message: v.message,
          knowledgeIds: [assoc.source_id, assoc.target_id],
          details: {
            associationId: assoc.id,
            associationType: assoc.association_type,
            sourceClass: source.knowledge_class,
            targetClass: target.knowledge_class,
          },
        });
      }
    }
  }

  // Check custom validation rules against existing knowledge
  for (const rule of config.validationRules) {
    const applicableKnowledge =
      rule.appliesTo.length > 0
        ? knowledge.filter((k) => rule.appliesTo.includes(k.knowledge_class))
        : knowledge;

    for (const k of applicableKnowledge) {
      if (rule.id === 'require_subject' && !k.fact_subject) {
        issues.push({
          severity: 'warning',
          category: ONTOLOGY_VIOLATION,
          message: `${rule.description}: Knowledge #${k.id} is missing a subject`,
          knowledgeIds: [k.id],
          details: { fact: k.fact, ruleId: rule.id },
        });
      }

      if (rule.id === 'require_attribute' && !k.fact_attribute) {
        issues.push({
          severity: 'warning',
          category: ONTOLOGY_VIOLATION,
          message: `${rule.description}: Knowledge #${k.id} is missing an attribute`,
          knowledgeIds: [k.id],
          details: { fact: k.fact, ruleId: rule.id },
        });
      }

      if (rule.id === 'require_value' && !k.fact_value) {
        issues.push({
          severity: 'warning',
          category: ONTOLOGY_VIOLATION,
          message: `${rule.description}: Knowledge #${k.id} is missing a value`,
          knowledgeIds: [k.id],
          details: { fact: k.fact, ruleId: rule.id },
        });
      }
    }
  }

  return issues;
}
