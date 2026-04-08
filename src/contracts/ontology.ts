import type { KnowledgeClass } from './types.js';
import type { AssociationType } from './types.js';

/**
 * Defines a custom entity type that extends beyond the built-in KnowledgeClass.
 */
export interface EntityTypeDefinition {
  /** Unique name for this entity type. */
  name: string;
  /** Human-readable description of what this entity type represents. */
  description: string;
  /** Which built-in knowledge class this entity type extends, if any. */
  extendsClass?: KnowledgeClass;
  /** Relationship types this entity is allowed to participate in. */
  allowedRelationships: AssociationType[];
}

/**
 * Constrains which entity types may connect via a given relationship type.
 */
export interface RelationshipConstraint {
  /** Entity type name for the source end of the relationship. */
  sourceType: string;
  /** Entity type name for the target end of the relationship. */
  targetType: string;
  /** The association/relationship type this constraint governs. */
  relationshipType: AssociationType;
  /** Whether the relationship is valid in both directions. */
  bidirectional: boolean;
}

/**
 * A single validation rule applied during ontology enforcement.
 */
export interface ValidationRule {
  /** Unique identifier for this rule. */
  id: string;
  /** Human-readable description of what this rule checks. */
  description: string;
  /** Entity type names this rule applies to; empty means all types. */
  appliesTo: string[];
  /** Whether violation of this rule is a hard error or a warning. */
  severity: 'error' | 'warning';
}

/**
 * Optional ontology configuration.
 * The system works without it — when absent, no ontology constraints are enforced.
 */
export interface OntologyConfig {
  /** Custom entity type definitions. */
  entityTypes: EntityTypeDefinition[];
  /** Constraints on which entity types may form relationships. */
  relationshipConstraints: RelationshipConstraint[];
  /** Validation rules to enforce on knowledge mutations. */
  validationRules: ValidationRule[];
}
