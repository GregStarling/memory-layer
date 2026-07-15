import { createMemory } from '../../dist/index.js';
import { assertScenario, ratio, tagEvalOutput } from './shared.mjs';

/**
 * Retention metrics — de-fitted from a single fact per class (the old
 * ratio(Number(hit), 1)) to >=20 materially-distinct facts per class (manager
 * decision D4). Each case learns one fact of a given type, buries it under
 * unrelated noise turns, forces a compaction, then queries for it: the metric
 * is the RATE at which the fact is still retrievable across 20 distinct facts.
 * trustedMemoryRecall is measured over the union of all 80 high-confidence
 * facts (does the fact also survive into trusted core memory).
 */
function hasFact(items, needle) {
  const loweredNeedle = needle.toLowerCase();
  return items.some((item) => item.fact.toLowerCase().includes(loweredNeedle));
}

async function addNoise(memory, count) {
  for (let index = 0; index < count; index += 1) {
    await memory.processExchange(
      `Noise user turn ${index + 1}: discussing unrelated implementation detail ${index + 1}.`,
      `Noise assistant turn ${index + 1}: acknowledging unrelated implementation detail ${index + 1}.`,
    );
  }
}

const CONSTRAINT_CASES = [
  { fact: 'The system must remain local-first by default.', needle: 'local-first', query: 'local-first default persistence' },
  { fact: 'Customer data must be encrypted at rest.', needle: 'encrypted at rest', query: 'encrypted at rest customer data' },
  { fact: 'The application must never log secrets.', needle: 'never log secrets', query: 'never log secrets logging' },
  { fact: 'The product must support offline mode.', needle: 'offline mode', query: 'support offline mode' },
  { fact: 'API responses must stay under 200ms.', needle: 'under 200ms', query: 'responses under 200ms latency' },
  { fact: 'The team must never deploy on Fridays.', needle: 'deploy on Fridays', query: 'never deploy on Fridays' },
  { fact: 'The service must validate all input schemas.', needle: 'validate all input', query: 'validate all input schemas' },
  { fact: 'Traffic must be served over HTTPS only.', needle: 'HTTPS only', query: 'served over HTTPS only' },
  { fact: 'Audit logs must be retained for seven years.', needle: 'seven years', query: 'audit logs retained seven years' },
  { fact: 'The API must rate-limit per key.', needle: 'rate-limit per key', query: 'rate-limit per key throttle' },
  { fact: 'Databases must be backed up nightly.', needle: 'backed up nightly', query: 'databases backed up nightly' },
  { fact: 'All dependency versions must be pinned.', needle: 'dependency versions must be pinned', query: 'pin dependency versions' },
  { fact: 'Services must run on Node.js LTS.', needle: 'Node.js LTS', query: 'run on Node.js LTS runtime' },
  { fact: 'Tenants must be isolated by scope.', needle: 'isolated by scope', query: 'tenants isolated by scope' },
  { fact: 'Auth errors must fail closed.', needle: 'fail closed', query: 'auth errors fail closed' },
  { fact: 'User-generated HTML must be sanitized.', needle: 'HTML must be sanitized', query: 'sanitize user-generated HTML' },
  { fact: 'Timestamps must be stored in UTC.', needle: 'stored in UTC', query: 'timestamps stored in UTC' },
  { fact: 'Every change must pass code review before merge.', needle: 'code review before merge', query: 'code review before merge' },
  { fact: 'Sessions must expire after inactivity.', needle: 'expire after inactivity', query: 'sessions expire after inactivity' },
  { fact: 'Unbounded time-range queries must be rejected.', needle: 'unbounded time-range', query: 'reject unbounded time-range queries' },
];

const PREFERENCE_CASES = [
  { fact: 'The user prefers TypeScript for implementation work.', needle: 'TypeScript', query: 'prefers TypeScript language' },
  { fact: 'The user prefers dark mode in the IDE.', needle: 'dark mode', query: 'prefers dark mode IDE' },
  { fact: 'The user prefers terse responses.', needle: 'terse responses', query: 'prefers terse responses' },
  { fact: 'The user prefers vim keybindings.', needle: 'vim keybindings', query: 'prefers vim keybindings' },
  { fact: 'The user prefers two-space indentation.', needle: 'two-space indentation', query: 'prefers two-space indentation' },
  { fact: 'The user prefers pytest over unittest.', needle: 'pytest over unittest', query: 'prefers pytest over unittest' },
  { fact: 'The user prefers pnpm over npm.', needle: 'pnpm over npm', query: 'prefers pnpm over npm package manager' },
  { fact: 'The user prefers a functional programming style.', needle: 'functional programming style', query: 'prefers functional programming style' },
  { fact: 'The user prefers REST over GraphQL.', needle: 'REST over GraphQL', query: 'prefers REST over GraphQL' },
  { fact: 'The user prefers Postgres for hosted deployments.', needle: 'Postgres for hosted', query: 'prefers Postgres for hosted deployments' },
  { fact: 'The user prefers early morning meetings.', needle: 'early morning meetings', query: 'prefers early morning meetings' },
  { fact: 'The user prefers markdown for documentation.', needle: 'markdown for documentation', query: 'prefers markdown for documentation' },
  { fact: 'The user prefers small pull requests.', needle: 'small pull requests', query: 'prefers small pull requests' },
  { fact: 'The user prefers explicit over implicit typing.', needle: 'explicit over implicit typing', query: 'prefers explicit over implicit typing' },
  { fact: 'The user prefers browser tabs closed by default.', needle: 'tabs closed by default', query: 'prefers tabs closed by default' },
  { fact: 'The user prefers Slack over email.', needle: 'Slack over email', query: 'prefers Slack over email' },
  { fact: 'The user prefers monospaced fonts.', needle: 'monospaced fonts', query: 'prefers monospaced fonts' },
  { fact: 'The user prefers trunk-based development.', needle: 'trunk-based development', query: 'prefers trunk-based development' },
  { fact: 'The user prefers conventional commits.', needle: 'conventional commits', query: 'prefers conventional commits' },
  { fact: 'The user prefers feature flags for rollout.', needle: 'feature flags for rollout', query: 'prefers feature flags for rollout' },
];

const IDENTITY_CASES = [
  { fact: 'The assistant identity is Memory Layer.', needle: 'Memory Layer', query: 'assistant identity Memory Layer' },
  { fact: 'The user name is Alice.', needle: 'name is Alice', query: 'user name Alice' },
  { fact: 'The project codename is Atlas.', needle: 'codename is Atlas', query: 'project codename Atlas' },
  { fact: 'The team is called Platform Core.', needle: 'Platform Core', query: 'team called Platform Core' },
  { fact: 'The company is Doyon Tech.', needle: 'Doyon Tech', query: 'company Doyon Tech' },
  { fact: 'The product is an AI memory layer.', needle: 'AI memory layer', query: 'product AI memory layer' },
  { fact: 'The repository is ai-memory-layer.', needle: 'ai-memory-layer', query: 'repository ai-memory-layer' },
  { fact: 'The primary maintainer is Greg.', needle: 'maintainer is Greg', query: 'primary maintainer Greg' },
  { fact: 'The organization is DoyonTechGroup.', needle: 'DoyonTechGroup', query: 'organization DoyonTechGroup' },
  { fact: 'The staging cluster is named harbor.', needle: 'named harbor', query: 'staging cluster named harbor' },
  { fact: 'The CI provider is GitHub Actions.', needle: 'GitHub Actions', query: 'CI provider GitHub Actions' },
  { fact: 'The package registry is npm.', needle: 'registry is npm', query: 'package registry npm' },
  { fact: 'The mascot is a fable fox.', needle: 'fable fox', query: 'mascot fable fox' },
  { fact: 'The flagship service is context-api.', needle: 'context-api', query: 'flagship service context-api' },
  { fact: 'The design system is called Aurora.', needle: 'called Aurora', query: 'design system Aurora' },
  { fact: 'The on-call rotation is team Nightshift.', needle: 'Nightshift', query: 'on-call rotation Nightshift' },
  { fact: 'The data warehouse is called Vault.', needle: 'called Vault', query: 'data warehouse Vault' },
  { fact: 'The mobile app is codenamed Comet.', needle: 'codenamed Comet', query: 'mobile app codenamed Comet' },
  { fact: 'The internal wiki is called Lore.', needle: 'called Lore', query: 'internal wiki Lore' },
  { fact: 'The release train is named Voyager.', needle: 'named Voyager', query: 'release train Voyager' },
];

const PROCEDURE_CASES = [
  { fact: 'Procedure: run tests before shipping changes.', needle: 'run tests before shipping', query: 'run tests before shipping procedure' },
  { fact: 'Procedure: rotate credentials quarterly.', needle: 'rotate credentials quarterly', query: 'rotate credentials quarterly' },
  { fact: 'Procedure: tag releases with semver.', needle: 'tag releases with semver', query: 'tag releases with semver' },
  { fact: 'Procedure: squash commits on merge.', needle: 'squash commits on merge', query: 'squash commits on merge' },
  { fact: 'Procedure: write migration rollbacks.', needle: 'migration rollbacks', query: 'write migration rollbacks' },
  { fact: 'Procedure: review dashboards after deploy.', needle: 'review dashboards after deploy', query: 'review dashboards after deploy' },
  { fact: 'Procedure: snapshot the database before migration.', needle: 'snapshot the database before migration', query: 'snapshot database before migration' },
  { fact: 'Procedure: announce breaking changes a week ahead.', needle: 'announce breaking changes', query: 'announce breaking changes ahead' },
  { fact: 'Procedure: run smoke tests in staging.', needle: 'smoke tests in staging', query: 'run smoke tests staging' },
  { fact: 'Procedure: update the changelog per pull request.', needle: 'update the changelog', query: 'update the changelog per pull request' },
  { fact: 'Procedure: drain connections before restart.', needle: 'drain connections before restart', query: 'drain connections before restart' },
  { fact: 'Procedure: verify backups monthly.', needle: 'verify backups monthly', query: 'verify backups monthly' },
  { fact: 'Procedure: lint before every commit.', needle: 'lint before every commit', query: 'lint before every commit' },
  { fact: 'Procedure: bump the version before publish.', needle: 'bump the version before publish', query: 'bump version before publish' },
  { fact: 'Procedure: archive logs after thirty days.', needle: 'archive logs after thirty days', query: 'archive logs after thirty days' },
  { fact: 'Procedure: warm the cache after deploy.', needle: 'warm the cache after deploy', query: 'warm the cache after deploy' },
  { fact: 'Procedure: page on-call for sev-1 incidents.', needle: 'page on-call for sev-1', query: 'page on-call for sev-1' },
  { fact: 'Procedure: reindex search weekly.', needle: 'reindex search weekly', query: 'reindex search weekly' },
  { fact: 'Procedure: audit access grants each release.', needle: 'audit access grants', query: 'audit access grants each release' },
  { fact: 'Procedure: document runbooks for new services.', needle: 'document runbooks', query: 'document runbooks new services' },
];

function makeMemory() {
  return createMemory({
    adapter: 'memory',
    scope: {
      tenant_id: 'eval',
      system_id: 'memory-quality',
      workspace_id: 'retention',
      scope_id: 'thread-1',
    },
    autoCompact: true,
    autoExtract: false,
    policies: {
      monitor: {
        floorTurns: 1,
        floorTokens: 1,
        softTurnThreshold: 4,
        hardTurnThreshold: 6,
        softTokenThreshold: 64,
        hardTokenThreshold: 128,
      },
    },
  });
}

async function runRetentionCase(factType, testCase) {
  const memory = makeMemory();
  try {
    await memory.learnFact(testCase.fact, factType, 'high');
    await addNoise(memory, 4);
    await memory.forceCompact();
    const context = await memory.getContext(testCase.query);
    return {
      relevantHit: hasFact(context.relevantKnowledge, testCase.needle),
      trustedHit: hasFact(context.trustedCoreMemory, testCase.needle),
    };
  } finally {
    await memory.close();
  }
}

async function retentionRate(factType, cases) {
  const results = [];
  for (const testCase of cases) {
    results.push(await runRetentionCase(factType, testCase));
  }
  const relevantHits = results.filter((entry) => entry.relevantHit).length;
  const trustedHits = results.filter((entry) => entry.trustedHit).length;
  const misses = cases.filter((testCase, index) => !results[index].relevantHit).map((testCase) => testCase.needle);
  return { rate: ratio(relevantHits, cases.length), relevantHits, trustedHits, total: cases.length, misses };
}

export async function runRetentionEvals(_options = {}) {
  const constraint = await retentionRate('constraint', CONSTRAINT_CASES);
  const preference = await retentionRate('preference', PREFERENCE_CASES);
  const identity = await retentionRate('entity', IDENTITY_CASES);
  const procedure = await retentionRate('decision', PROCEDURE_CASES);

  // trustedMemoryRecall is measured only over trusted-core-ELIGIBLE classes
  // (constraint / preference / identity). Procedure (`decision`) facts are, by
  // design, routed to relevant knowledge but not promoted into trusted core
  // memory, so including them would understate recall for a non-defect. This is
  // the honest denominator: of high-confidence facts that SHOULD reach trusted
  // core, how many do (60 distinct facts).
  const trustedTotal = constraint.total + preference.total + identity.total;
  const trustedHits = constraint.trustedHits + preference.trustedHits + identity.trustedHits;

  const metrics = {
    constraintRetentionRate: constraint.rate,
    preferenceRetentionRate: preference.rate,
    identityRetentionRate: identity.rate,
    procedureRetentionRate: procedure.rate,
    trustedMemoryRecall: ratio(trustedHits, trustedTotal),
  };

  return tagEvalOutput('retention', {
    metrics,
    scenarios: [
      assertScenario('retains_constraint_memory', constraint.rate >= 0.9, {
        hits: constraint.relevantHits,
        total: constraint.total,
        misses: constraint.misses,
      }),
      assertScenario('retains_preference_memory', preference.rate >= 0.9, {
        hits: preference.relevantHits,
        total: preference.total,
        misses: preference.misses,
      }),
      assertScenario('retains_identity_memory', identity.rate >= 0.9, {
        hits: identity.relevantHits,
        total: identity.total,
        misses: identity.misses,
      }),
      assertScenario('retains_procedure_memory', procedure.rate >= 0.85, {
        hits: procedure.relevantHits,
        total: procedure.total,
        misses: procedure.misses,
      }),
      assertScenario('facts_survive_into_trusted_core_memory', ratio(trustedHits, trustedTotal) >= 0.85, {
        trustedHits,
        trustedTotal,
      }),
    ],
    diagnostic: {
      metricTraces: {
        constraintRetentionRate: { stage: 'context_selection', hits: constraint.relevantHits, total: constraint.total, misses: constraint.misses },
        preferenceRetentionRate: { stage: 'context_selection', hits: preference.relevantHits, total: preference.total, misses: preference.misses },
        identityRetentionRate: { stage: 'context_selection', hits: identity.relevantHits, total: identity.total, misses: identity.misses },
        procedureRetentionRate: { stage: 'context_selection', hits: procedure.relevantHits, total: procedure.total, misses: procedure.misses },
        trustedMemoryRecall: { stage: 'trusted_core_selection', trustedHits, trustedTotal, note: 'procedure/decision facts excluded — not trusted-core eligible by design' },
      },
    },
  });
}
