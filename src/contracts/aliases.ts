export type AliasMap = Record<string, string[]>;

export interface AliasConfig {
  aliases: AliasMap;
  scopeId: string;
}

export interface AliasCandidate {
  entity1: string;
  entity2: string;
  similarity: number;
  suggestedCanonical: string;
  confirmed: boolean;
}
