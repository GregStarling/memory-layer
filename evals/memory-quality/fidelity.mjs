import {
  buildMemoryContext,
  compactTurns,
  createInMemoryAdapter,
  extractKnowledge,
  wrapSyncAdapter,
} from '../../dist/index.js';
import { assertScenario, average, ratio, tagEvalOutput } from './shared.mjs';

/**
 * postCompactionFidelityScore — de-fitted from a single compaction scenario
 * (average of 2 booleans) to >=20 materially-distinct compaction cases
 * (manager decision D4). Each case buries a critical constraint plus a
 * secondary detail in a conversation, compacts it under a (mocked) summary that
 * only mentions the secondary detail, and checks that BOTH survive: the
 * critical constraint into retrievable knowledge and the secondary detail into
 * the retained summary. The metric is the mean per-case fidelity across 20
 * distinct topics (deploy, storage, auth, UI, data, process...).
 */
function containsFact(context, fragment) {
  return context.relevantKnowledge.some((item) => item.fact.toLowerCase().includes(fragment.toLowerCase()));
}

function containsSummaryDetail(context, fragment) {
  const needle = fragment.toLowerCase();
  if (context.workingMemory?.summary?.toLowerCase().includes(needle)) {
    return true;
  }
  return context.recentSummaries.some((item) => item.summary.toLowerCase().includes(needle));
}

const FIDELITY_CASES = [
  { constraint: 'the system must remain local-first', needle: 'local-first', summary: 'The project uses green UI styling.', secondary: 'green UI styling' },
  { constraint: 'the system must encrypt data at rest', needle: 'encrypt data at rest', summary: 'The onboarding flow was simplified.', secondary: 'onboarding flow' },
  { constraint: 'the system must require authentication on every route', needle: 'require authentication', summary: 'The footer links were reordered.', secondary: 'footer links' },
  { constraint: 'the system must support offline mode', needle: 'offline mode', summary: 'The icon set moved to outline style.', secondary: 'outline style' },
  { constraint: 'the system must respond within 200 milliseconds', needle: '200 milliseconds', summary: 'The changelog page got a new banner.', secondary: 'new banner' },
  { constraint: 'the system must never deploy on Fridays', needle: 'never deploy on Fridays', summary: 'The settings menu was regrouped.', secondary: 'settings menu' },
  { constraint: 'the system must validate every input schema', needle: 'validate every input schema', summary: 'The empty state copy was refreshed.', secondary: 'empty state copy' },
  { constraint: 'the system must serve traffic over HTTPS only', needle: 'HTTPS only', summary: 'The avatar shape became circular.', secondary: 'avatar shape' },
  { constraint: 'the system must retain audit logs for seven years', needle: 'seven years', summary: 'The table stripes were softened.', secondary: 'table stripes' },
  { constraint: 'the system must rate-limit each API key', needle: 'rate-limit each API key', summary: 'The tooltip delay was shortened.', secondary: 'tooltip delay' },
  { constraint: 'the system must back up databases nightly', needle: 'back up databases nightly', summary: 'The sidebar width was reduced.', secondary: 'sidebar width' },
  { constraint: 'the system must pin every dependency version', needle: 'pin every dependency version', summary: 'The button radius was increased.', secondary: 'button radius' },
  { constraint: 'the system must isolate tenants by scope', needle: 'isolate tenants by scope', summary: 'The modal animation was smoothed.', secondary: 'modal animation' },
  { constraint: 'the system must fail closed on auth errors', needle: 'fail closed', summary: 'The date picker layout changed.', secondary: 'date picker layout' },
  { constraint: 'the system must sanitize user-generated HTML', needle: 'sanitize user-generated HTML', summary: 'The toast position moved to the top.', secondary: 'toast position' },
  { constraint: 'the system must store timestamps in UTC', needle: 'timestamps in UTC', summary: 'The nav bar gained a search box.', secondary: 'search box' },
  { constraint: 'the system must require review before merge', needle: 'require review before merge', summary: 'The card shadow was deepened.', secondary: 'card shadow' },
  { constraint: 'the system must expire idle sessions', needle: 'expire idle sessions', summary: 'The spinner color was updated.', secondary: 'spinner color' },
  { constraint: 'the system must reject unbounded queries', needle: 'reject unbounded queries', summary: 'The header font weight was bumped.', secondary: 'header font weight' },
  { constraint: 'the system must run migrations transactionally', needle: 'migrations transactionally', summary: 'The badge shape became a pill.', secondary: 'badge shape' },
  { constraint: 'the system must checksum every upload', needle: 'checksum every upload', summary: 'The link hover underline returned.', secondary: 'hover underline' },
];

async function runFidelityCase(testCase, index) {
  const scope = {
    tenant_id: 'eval',
    system_id: 'memory-quality',
    workspace_id: 'fidelity',
    scope_id: `thread-${index + 1}`,
  };
  const sessionId = `session-${index + 1}`;
  const adapter = createInMemoryAdapter();
  const asyncAdapter = wrapSyncAdapter(adapter);
  try {
    const turns = adapter.insertTurns([
      { ...scope, session_id: sessionId, actor: 'user', role: 'user', content: `Critical constraint: ${testCase.constraint} and avoid regressions by default.` },
      { ...scope, session_id: sessionId, actor: 'assistant', role: 'assistant', content: 'Understood.' },
      { ...scope, session_id: sessionId, actor: 'user', role: 'user', content: `Secondary detail: ${testCase.summary}` },
      { ...scope, session_id: sessionId, actor: 'assistant', role: 'assistant', content: 'Acknowledged.' },
    ]);

    const compaction = await compactTurns(
      asyncAdapter,
      scope,
      sessionId,
      turns,
      async () => ({
        summary: `${testCase.summary} Mention the ${testCase.secondary} update.`,
        key_entities: [],
        topic_tags: [],
      }),
      'manual',
      0,
    );

    await extractKnowledge(asyncAdapter, compaction.workingMemory.id, scope, async (summary) =>
      summary.includes(testCase.secondary)
        ? [{ fact: testCase.summary, factType: 'reference', confidence: 'medium' }]
        : [],
    );

    const context = await buildMemoryContext(asyncAdapter, scope, {
      relevanceQuery: `${testCase.needle} ${testCase.secondary}`,
    });
    const criticalPreserved = containsFact(context, testCase.needle);
    const secondaryPreserved =
      containsFact(context, testCase.secondary) || containsSummaryDetail(context, testCase.secondary);
    return {
      name: testCase.needle,
      criticalPreserved,
      secondaryPreserved,
      score: average([Number(criticalPreserved), Number(secondaryPreserved)]),
    };
  } finally {
    await asyncAdapter.close();
  }
}

export async function runFidelityEvals(_options = {}) {
  const results = [];
  for (let index = 0; index < FIDELITY_CASES.length; index += 1) {
    results.push(await runFidelityCase(FIDELITY_CASES[index], index));
  }

  const postCompactionFidelityScore = average(results.map((entry) => entry.score));
  const criticalHits = results.filter((entry) => entry.criticalPreserved).length;
  const secondaryHits = results.filter((entry) => entry.secondaryPreserved).length;
  const criticalMisses = results.filter((entry) => !entry.criticalPreserved).map((entry) => entry.name);

  return tagEvalOutput('fidelity', {
    metrics: {
      postCompactionFidelityScore,
    },
    scenarios: [
      assertScenario('critical_constraints_survive_compaction', ratio(criticalHits, results.length) >= 0.9, {
        criticalHits,
        total: results.length,
        criticalMisses,
      }),
      assertScenario('secondary_details_survive_compaction', ratio(secondaryHits, results.length) >= 0.9, {
        secondaryHits,
        total: results.length,
      }),
    ],
    diagnostic: {
      metricTraces: {
        postCompactionFidelityScore: {
          stage: 'post_compaction_context',
          cases: results.length,
          criticalHits,
          secondaryHits,
          criticalMisses,
        },
      },
    },
  });
}
