export interface GraphReportSection {
  title: string;
  content: string;
  priority: number;
}

export interface GraphReportOptions {
  tokenBudget?: number;
  includeSections?: string[];
  filterByTags?: string[];
}

export interface GraphReport {
  sections: GraphReportSection[];
  tokenEstimate: number;
  generatedAt: string;
}

export const GRAPH_REPORT_DEFAULTS = {
  tokenBudget: 2000,
} as const;
