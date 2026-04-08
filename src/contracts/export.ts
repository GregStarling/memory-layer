export interface MarkdownExportOptions {
  includeEvidence?: boolean;
  includeTrustMetadata?: boolean;
  includeChangelog?: boolean;
  changelogLimit?: number;
  groupBy?: 'knowledge_class' | 'topic' | 'tag' | 'flat';
  filterByTags?: string[];
  includeSourceDocuments?: boolean;
}

export interface MarkdownExportResult {
  files: Map<string, string>;
  stats: {
    totalFacts: number;
    totalFiles: number;
    totalAssociations: number;
  };
}
