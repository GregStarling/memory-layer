import type { AliasMap } from '../contracts/aliases.js';
import type { OntologyConfig } from '../contracts/ontology.js';

export const SCOPE_CONFIG_KEYS = {
  aliases: 'aliases',
  ontology: 'ontology',
} as const;

export type ScopeConfigKey = (typeof SCOPE_CONFIG_KEYS)[keyof typeof SCOPE_CONFIG_KEYS];

export function serializeAliases(aliasMap: AliasMap): string {
  return JSON.stringify(aliasMap);
}

export function parseAliases(value: string | null): AliasMap | undefined {
  if (value == null) return undefined;
  return JSON.parse(value) as AliasMap;
}

export function serializeOntology(ontology: OntologyConfig): string {
  return JSON.stringify(ontology);
}

export function parseOntology(value: string | null): OntologyConfig | undefined {
  if (value == null) return undefined;
  return JSON.parse(value) as OntologyConfig;
}
