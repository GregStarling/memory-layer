export interface SessionState {
  currentObjective: string | null;
  blockers: string[];
  assumptions: string[];
  pendingDecisions: string[];
  activeTools: string[];
  recentOutputs: string[];
  updatedAt: number;
}
