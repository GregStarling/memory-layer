import type { MemoryScope, ScopeLevel } from '../contracts/identity.js';
import type { AsyncStorageAdapter } from '../contracts/async-storage.js';
import type { KnowledgeClass, KnowledgeMemory } from '../contracts/types.js';
import type {
  Profile,
  ProfileEntry,
  ProfileOptions,
  ProfileSection,
  ProfileView,
} from '../contracts/profile.js';

const COMMUNICATION_KEYWORD_PATTERNS = [
  'tone', 'voice', 'format', 'style', 'language', 'verbose', 'terse',
  'concise', 'emoji', 'markdown', 'response', 'communicate', 'explain',
].map((kw) => new RegExp(`\\b${kw}\\b`, 'i'));

const ALL_SECTIONS: ProfileSection[] = [
  'identity',
  'preferences',
  'communication',
  'constraints',
  'workflows',
];

function viewToScopeLevel(view: ProfileView): ScopeLevel {
  switch (view) {
    case 'user':
      return 'scope';
    case 'operator':
      return 'system';
    case 'workspace':
      return 'workspace';
  }
}

export function classifyProfileSection(
  knowledgeClass: KnowledgeClass,
  fact: string,
): ProfileSection {
  if (knowledgeClass === 'identity') return 'identity';
  if (knowledgeClass === 'constraint') return 'constraints';
  if (knowledgeClass === 'procedure' || knowledgeClass === 'strategy') return 'workflows';
  if (knowledgeClass === 'anti_pattern') return 'constraints';

  if (knowledgeClass === 'preference') {
    if (COMMUNICATION_KEYWORD_PATTERNS.some((pattern) => pattern.test(fact))) {
      return 'communication';
    }
    return 'preferences';
  }

  // project_fact, episodic_fact default to preferences
  return 'preferences';
}

function knowledgeToEntry(km: KnowledgeMemory): ProfileEntry {
  return {
    knowledgeId: km.id,
    fact: km.fact,
    trustScore: km.trust_score,
    knowledgeState: km.knowledge_state,
    confidence: km.confidence,
    lastConfirmedAt: km.last_confirmed_at,
  };
}

function emptyProfile(view: ProfileView): Profile {
  return {
    view,
    sections: {
      identity: [],
      preferences: [],
      communication: [],
      constraints: [],
      workflows: [],
    },
    generatedAt: Math.floor(Date.now() / 1000),
  };
}

export function buildProfileFromKnowledge(
  knowledge: KnowledgeMemory[],
  options: ProfileOptions = {},
): Profile {
  const view = options.view ?? 'user';
  const includeProvisional = options.includeProvisional ?? false;
  const includeDisputed = options.includeDisputed ?? false;
  const minimumTrustScore = options.minimumTrustScore ?? 0;
  const requestedSections = options.sections ?? ALL_SECTIONS;
  const profile = emptyProfile(view);

  for (const km of knowledge) {
    // Exclude retired/superseded
    if (km.knowledge_state === 'retired' || km.knowledge_state === 'superseded') continue;
    // Profiles surface trusted knowledge by default. Provisional entries are
    // opt-in so that agents do not personalize behavior on low-confidence
    // facts. Disputed entries also require explicit opt-in.
    if (!includeProvisional && km.knowledge_state === 'provisional') continue;
    if (!includeDisputed && km.knowledge_state === 'disputed') continue;
    // Trust score filter
    if (km.trust_score < minimumTrustScore) continue;

    const section = classifyProfileSection(km.knowledge_class, km.fact);
    if (!requestedSections.includes(section)) continue;

    profile.sections[section].push(knowledgeToEntry(km));
  }

  // Sort each section by trust score descending
  for (const section of ALL_SECTIONS) {
    profile.sections[section].sort((a, b) => b.trustScore - a.trustScore);
  }

  return profile;
}

export async function getProfile(
  adapter: AsyncStorageAdapter,
  scope: MemoryScope,
  options: ProfileOptions = {},
): Promise<Profile> {
  const view = options.view ?? 'user';
  const scopeLevel = viewToScopeLevel(view);
  const knowledge = scopeLevel === 'scope'
    ? await adapter.getActiveKnowledgeMemory(scope)
    : await adapter.getActiveKnowledgeCrossScope(scope, scopeLevel);
  return buildProfileFromKnowledge(knowledge, options);
}
