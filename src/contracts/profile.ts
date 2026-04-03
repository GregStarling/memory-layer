import type { FactConfidence, KnowledgeState } from './types.js';

export type ProfileView = 'user' | 'operator' | 'workspace';

export type ProfileSection =
  | 'identity'
  | 'preferences'
  | 'communication'
  | 'constraints'
  | 'workflows';

export interface ProfileEntry {
  knowledgeId: number;
  fact: string;
  trustScore: number;
  knowledgeState: KnowledgeState;
  confidence: FactConfidence;
  lastConfirmedAt: number | null;
}

export interface Profile {
  view: ProfileView;
  sections: Record<ProfileSection, ProfileEntry[]>;
  generatedAt: number;
}

export interface ProfileOptions {
  view?: ProfileView;
  minimumTrustScore?: number;
  includeDisputed?: boolean;
  sections?: ProfileSection[];
}
