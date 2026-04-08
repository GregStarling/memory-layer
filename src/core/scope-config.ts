import type { AliasMap } from '../contracts/aliases.js';
import type { OntologyConfig } from '../contracts/ontology.js';
import { ValidationError } from '../contracts/errors.js';
import {
  ASSOCIATION_TYPES,
  KNOWLEDGE_CLASSES,
  type AssociationType,
  type KnowledgeClass,
} from '../contracts/types.js';

export const SCOPE_CONFIG_KEYS = {
  aliases: 'aliases',
  ontology: 'ontology',
} as const;

export type ScopeConfigKey = (typeof SCOPE_CONFIG_KEYS)[keyof typeof SCOPE_CONFIG_KEYS];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function invalidField(path: string): ValidationError {
  return new ValidationError(`Invalid field: ${path}`);
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalidField(path);
  }
  return value.trim();
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw invalidField(path);
  }
  return value;
}

function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): T {
  const normalized = requireString(value, path);
  if (!allowed.includes(normalized as T)) {
    throw invalidField(path);
  }
  return normalized as T;
}

function requireStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    throw invalidField(path);
  }
  return value.map((entry, index) => requireString(entry, `${path}[${index}]`));
}

function requireEnumArray<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): T[] {
  if (!Array.isArray(value)) {
    throw invalidField(path);
  }
  return value.map((entry, index) => requireEnum(entry, allowed, `${path}[${index}]`));
}

export function normalizeAliasMap(value: unknown, path = 'aliases'): AliasMap {
  if (!isRecord(value)) {
    throw invalidField(path);
  }
  const normalized: AliasMap = {};
  for (const [canonical, aliases] of Object.entries(value)) {
    const canonicalName = requireString(canonical, `${path}.<key>`);
    const aliasValues = requireStringArray(aliases, `${path}.${canonicalName}`);
    normalized[canonicalName] = [...new Set(aliasValues)];
  }
  return normalized;
}

export function normalizeOntologyConfig(value: unknown, path = 'ontology'): OntologyConfig {
  if (!isRecord(value)) {
    throw invalidField(path);
  }

  if (!Array.isArray(value.entityTypes)) {
    throw invalidField(`${path}.entityTypes`);
  }
  if (!Array.isArray(value.relationshipConstraints)) {
    throw invalidField(`${path}.relationshipConstraints`);
  }
  if (!Array.isArray(value.validationRules)) {
    throw invalidField(`${path}.validationRules`);
  }

  return {
    entityTypes: value.entityTypes.map((entry, index) => {
      if (!isRecord(entry)) {
        throw invalidField(`${path}.entityTypes[${index}]`);
      }
      return {
        name: requireString(entry.name, `${path}.entityTypes[${index}].name`),
        description: requireString(
          entry.description,
          `${path}.entityTypes[${index}].description`,
        ),
        extendsClass:
          entry.extendsClass == null
            ? undefined
            : requireEnum(
                entry.extendsClass,
                KNOWLEDGE_CLASSES,
                `${path}.entityTypes[${index}].extendsClass`,
              ) as KnowledgeClass,
        allowedRelationships: requireEnumArray(
          entry.allowedRelationships,
          ASSOCIATION_TYPES,
          `${path}.entityTypes[${index}].allowedRelationships`,
        ) as AssociationType[],
      };
    }),
    relationshipConstraints: value.relationshipConstraints.map((entry, index) => {
      if (!isRecord(entry)) {
        throw invalidField(`${path}.relationshipConstraints[${index}]`);
      }
      return {
        sourceType: requireString(
          entry.sourceType,
          `${path}.relationshipConstraints[${index}].sourceType`,
        ),
        targetType: requireString(
          entry.targetType,
          `${path}.relationshipConstraints[${index}].targetType`,
        ),
        relationshipType: requireEnum(
          entry.relationshipType,
          ASSOCIATION_TYPES,
          `${path}.relationshipConstraints[${index}].relationshipType`,
        ) as AssociationType,
        bidirectional: requireBoolean(
          entry.bidirectional,
          `${path}.relationshipConstraints[${index}].bidirectional`,
        ),
      };
    }),
    validationRules: value.validationRules.map((entry, index) => {
      if (!isRecord(entry)) {
        throw invalidField(`${path}.validationRules[${index}]`);
      }
      return {
        id: requireString(entry.id, `${path}.validationRules[${index}].id`),
        description: requireString(
          entry.description,
          `${path}.validationRules[${index}].description`,
        ),
        appliesTo: requireStringArray(
          entry.appliesTo,
          `${path}.validationRules[${index}].appliesTo`,
        ),
        severity: requireEnum(
          entry.severity,
          ['error', 'warning'] as const,
          `${path}.validationRules[${index}].severity`,
        ),
      };
    }),
  };
}

export function serializeAliases(aliasMap: AliasMap): string {
  return JSON.stringify(normalizeAliasMap(aliasMap));
}

export function parseAliases(value: string | null): AliasMap | undefined {
  if (value == null) return undefined;
  try {
    return normalizeAliasMap(JSON.parse(value));
  } catch {
    return undefined;
  }
}

export function serializeOntology(ontology: OntologyConfig): string {
  return JSON.stringify(normalizeOntologyConfig(ontology));
}

export function parseOntology(value: string | null): OntologyConfig | undefined {
  if (value == null) return undefined;
  try {
    return normalizeOntologyConfig(JSON.parse(value));
  } catch {
    return undefined;
  }
}
