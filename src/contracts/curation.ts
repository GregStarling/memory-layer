export type CurationActionType =
  | 'retired'
  | 'expired'
  | 'demoted'
  | 'reflected'
  | 'merged'
  | 'derived'
  | 'reverified';

export type CurationSource =
  | 'maintenance'
  | 'reflection'
  | 'ontology'
  | 'derived_pipeline';

export interface CurationAction {
  actionType: CurationActionType;
  affectedEntities: string[];
  explanation: string;
  timestamp: number;
  source: CurationSource;
}

export interface CurationSummary {
  actions: CurationAction[];
  period: { start: number; end: number };
  maintenanceRef?: string;
  reflectionRef?: string;
}

export interface CurationOptions {
  since?: number;
  actionTypes?: CurationActionType[];
  limit?: number;
}
