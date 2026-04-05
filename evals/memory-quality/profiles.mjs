import { createSQLiteAdapter } from '../../dist/adapters/sqlite/index.js';
import { wrapSyncAdapter } from '../../dist/adapters/sync-to-async.js';
import { getProfile } from '../../dist/core/profile.js';
import { assertScenario, ratio, tagEvalOutput } from './shared.mjs';

function makeScope(overrides = {}) {
  return {
    tenant_id: 'eval',
    system_id: 'memory-quality',
    workspace_id: 'profiles',
    scope_id: 'thread-1',
    ...overrides,
  };
}

function seedKnowledge(adapter, scope, facts) {
  for (const f of facts) {
    adapter.insertKnowledgeMemory({
      ...scope,
      fact: f.fact,
      fact_type: f.factType ?? 'entity',
      knowledge_class: f.knowledgeClass ?? 'preference',
      source: 'user_stated',
      confidence: f.confidence ?? 'high',
      trust_score: f.trustScore ?? 0.9,
      knowledge_state: f.knowledgeState ?? 'trusted',
    });
  }
}

// ---------- Metric 1: profile_completeness ----------
async function evalProfileCompleteness() {
  const adapter = createSQLiteAdapter(':memory:');
  const asyncAdapter = wrapSyncAdapter(adapter);
  const scope = makeScope();

  seedKnowledge(adapter, scope, [
    { fact: 'User name is Alice', knowledgeClass: 'identity' },
    { fact: 'Prefers dark mode', knowledgeClass: 'preference' },
    { fact: 'Prefers terse responses', knowledgeClass: 'preference' },
    { fact: 'Must not use eval()', knowledgeClass: 'constraint' },
    { fact: 'Deploy with Docker Compose', knowledgeClass: 'procedure' },
    { fact: 'Avoid premature optimization', knowledgeClass: 'strategy' },
  ]);

  const profile = await getProfile(asyncAdapter, scope);

  const identityCount = profile.sections.identity.length;
  const preferencesCount = profile.sections.preferences.length;
  const communicationCount = profile.sections.communication.length;
  const constraintsCount = profile.sections.constraints.length;
  const workflowsCount = profile.sections.workflows.length;

  // identity: 1 (Alice), preferences: 1 (dark mode), communication: 1 (terse),
  // constraints: 1 (eval), workflows: 2 (docker compose + avoid premature opt)
  const totalExpected = 6;
  const totalFound = identityCount + preferencesCount + communicationCount + constraintsCount + workflowsCount;
  const score = ratio(totalFound, totalExpected);

  const scenarios = [
    assertScenario('profile_has_identity_entries', identityCount >= 1, { identityCount }),
    assertScenario('profile_has_preference_entries', preferencesCount >= 1, { preferencesCount }),
    assertScenario('profile_has_communication_entries', communicationCount >= 1, { communicationCount }),
    assertScenario('profile_has_constraint_entries', constraintsCount >= 1, { constraintsCount }),
    assertScenario('profile_has_workflow_entries', workflowsCount >= 1, { workflowsCount }),
  ];

  adapter.close();
  return { score, scenarios };
}

// ---------- Metric 2: profile_trust_filtering ----------
async function evalProfileTrustFiltering() {
  const adapter = createSQLiteAdapter(':memory:');
  const asyncAdapter = wrapSyncAdapter(adapter);
  const scope = makeScope();

  seedKnowledge(adapter, scope, [
    { fact: 'User name is Bob', knowledgeClass: 'identity', trustScore: 0.95, knowledgeState: 'trusted' },
    { fact: 'Likes tabs over spaces', knowledgeClass: 'preference', trustScore: 0.3, knowledgeState: 'provisional' },
    { fact: 'Prefers Python', knowledgeClass: 'preference', trustScore: 0.85, knowledgeState: 'trusted' },
    { fact: 'Disputed claim about Go', knowledgeClass: 'preference', trustScore: 0.5, knowledgeState: 'disputed' },
    { fact: 'Retired old preference', knowledgeClass: 'preference', trustScore: 0.9, knowledgeState: 'retired' },
  ]);

  // Default: no disputed, no minimum trust
  const defaultProfile = await getProfile(asyncAdapter, scope);
  const defaultEntries = Object.values(defaultProfile.sections).flat();
  const hasDisputed = defaultEntries.some((e) => e.knowledgeState === 'disputed');
  const hasRetired = defaultEntries.some((e) => e.knowledgeState === 'retired');

  // With minimum trust score
  const filteredProfile = await getProfile(asyncAdapter, scope, { minimumTrustScore: 0.8 });
  const filteredEntries = Object.values(filteredProfile.sections).flat();
  const allAboveThreshold = filteredEntries.every((e) => e.trustScore >= 0.8);

  // With disputed included
  const disputedProfile = await getProfile(asyncAdapter, scope, { includeDisputed: true });
  const disputedEntries = Object.values(disputedProfile.sections).flat();
  const includesDisputed = disputedEntries.some((e) => e.knowledgeState === 'disputed');

  let passed = 0;
  const checks = 4;
  if (!hasDisputed) passed++;
  if (!hasRetired) passed++;
  if (allAboveThreshold) passed++;
  if (includesDisputed) passed++;
  const score = ratio(passed, checks);

  const scenarios = [
    assertScenario('default_excludes_disputed', !hasDisputed, { hasDisputed }),
    assertScenario('default_excludes_retired', !hasRetired, { hasRetired }),
    assertScenario('trust_filter_enforced', allAboveThreshold, {
      filteredCount: filteredEntries.length,
      allAboveThreshold,
    }),
    assertScenario('disputed_included_when_requested', includesDisputed, {
      disputedCount: disputedEntries.filter((e) => e.knowledgeState === 'disputed').length,
    }),
  ];

  adapter.close();
  return { score, scenarios };
}

// ---------- Metric 3: profile_provenance ----------
async function evalProfileProvenance() {
  const adapter = createSQLiteAdapter(':memory:');
  const asyncAdapter = wrapSyncAdapter(adapter);
  const scope = makeScope();

  seedKnowledge(adapter, scope, [
    { fact: 'User is a senior engineer', knowledgeClass: 'identity', trustScore: 0.92, confidence: 'high' },
    { fact: 'Prefers vim keybindings', knowledgeClass: 'preference', trustScore: 0.88, confidence: 'medium' },
    { fact: 'Never deploy on Friday', knowledgeClass: 'constraint', trustScore: 0.95, confidence: 'high' },
  ]);

  const profile = await getProfile(asyncAdapter, scope);
  const allEntries = Object.values(profile.sections).flat();

  // Every entry should have provenance: knowledgeId, trustScore, knowledgeState, confidence
  const allHaveId = allEntries.every((e) => typeof e.knowledgeId === 'number' && e.knowledgeId > 0);
  const allHaveTrust = allEntries.every((e) => typeof e.trustScore === 'number');
  const allHaveState = allEntries.every((e) => typeof e.knowledgeState === 'string' && e.knowledgeState.length > 0);
  const allHaveConfidence = allEntries.every((e) => typeof e.confidence === 'string' && e.confidence.length > 0);

  // Entries should be sorted by trust score descending within sections
  let sortCorrect = true;
  for (const entries of Object.values(profile.sections)) {
    for (let i = 1; i < entries.length; i++) {
      if (entries[i].trustScore > entries[i - 1].trustScore) {
        sortCorrect = false;
        break;
      }
    }
  }

  let passed = 0;
  const checks = 5;
  if (allHaveId) passed++;
  if (allHaveTrust) passed++;
  if (allHaveState) passed++;
  if (allHaveConfidence) passed++;
  if (sortCorrect) passed++;
  const score = ratio(passed, checks);

  const scenarios = [
    assertScenario('entries_have_knowledge_id', allHaveId, { entryCount: allEntries.length }),
    assertScenario('entries_have_trust_score', allHaveTrust, {}),
    assertScenario('entries_have_knowledge_state', allHaveState, {}),
    assertScenario('entries_have_confidence', allHaveConfidence, {}),
    assertScenario('entries_sorted_by_trust', sortCorrect, {}),
  ];

  adapter.close();
  return { score, scenarios };
}

// ---------- Run all ----------
export async function runProfileEvals(options = {}) {
  const [completeness, trustFiltering, provenance] = await Promise.all([
    evalProfileCompleteness(),
    evalProfileTrustFiltering(),
    evalProfileProvenance(),
  ]);

  const metrics = {
    profileCompleteness: completeness.score,
    profileTrustFiltering: trustFiltering.score,
    profileProvenance: provenance.score,
  };

  const scenarios = [
    ...completeness.scenarios,
    ...trustFiltering.scenarios,
    ...provenance.scenarios,
  ];

  return tagEvalOutput('profiles', { metrics, scenarios });
}
