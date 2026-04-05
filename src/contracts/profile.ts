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
  /**
   * When true, include provisional-state knowledge in the profile.
   * Default: false — profiles only surface trusted knowledge so agents
   * cannot over-trust low-confidence entries and personalize incorrectly.
   */
  includeProvisional?: boolean;
  includeDisputed?: boolean;
  sections?: ProfileSection[];
}
