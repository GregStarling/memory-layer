import {
  buildMemoryContext,
  compactTurns,
  createInMemoryAdapter,
  extractKnowledge,
  wrapSyncAdapter,
} from '../../dist/index.js';
import { assertScenario, ratio, tagEvalOutput } from './shared.mjs';

/**
 * falseMemoryRate — de-fitted from a single example (the old ratio(x, 1) at
 * false-memory.mjs:89) to >=20 materially-distinct cases (manager decision D4).
 *
 * Each case is a hallucinated-summary scenario: the user/assistant turns assert
 * one thing, the (mocked) summarizer emits a summary that asserts a DIFFERENT,
 * unsupported "fact", and the (mocked) extractor lifts that false fact out of
 * the summary. The metric is the RATE at which such ungrounded facts leak into
 * the retrieved context. The promotion/grounding guard should keep every one of
 * them out, so the honest measured rate is 0. The cases span deployment,
 * language, storage, auth, UI, testing, and process domains — not one template
 * with a word swapped.
 */
const FALSE_MEMORY_CASES = [
  {
    name: 'docker_vs_local',
    turns: [
      'Please avoid Docker-first deployment paths unless absolutely necessary.',
      'Understood. I will avoid defaulting to Docker-first deployment paths.',
      'The safest default is local-first persistence.',
      'Acknowledged. I will preserve the local-first default.',
    ],
    falseSummary: 'The user wants a Docker-first deployment strategy.',
    falseFact: 'The user wants a Docker-first deployment strategy.',
    falseNeedle: 'Docker-first deployment strategy',
  },
  {
    name: 'typescript_vs_python',
    turns: [
      'We standardize on TypeScript for all backend services.',
      'Got it, TypeScript everywhere on the backend.',
    ],
    falseSummary: 'The team decided to rewrite the backend in Python.',
    falseFact: 'The team decided to rewrite the backend in Python.',
    falseNeedle: 'rewrite the backend in Python',
  },
  {
    name: 'sqlite_vs_mongo',
    turns: [
      'Storage should stay on SQLite for the embedded use case.',
      'Understood, SQLite remains the embedded store.',
    ],
    falseSummary: 'The user migrated all data to MongoDB.',
    falseFact: 'The user migrated all data to MongoDB.',
    falseNeedle: 'migrated all data to MongoDB',
  },
  {
    name: 'auth_required',
    turns: [
      'Every endpoint must require authentication.',
      'Confirmed, all endpoints will require auth.',
    ],
    falseSummary: 'Authentication is disabled for all public endpoints.',
    falseFact: 'Authentication is disabled for all public endpoints.',
    falseNeedle: 'Authentication is disabled',
  },
  {
    name: 'dark_theme',
    turns: [
      'The dashboard should default to a dark theme.',
      'Okay, dark theme is the default for the dashboard.',
    ],
    falseSummary: 'The dashboard defaults to a bright yellow theme.',
    falseFact: 'The dashboard defaults to a bright yellow theme.',
    falseNeedle: 'bright yellow theme',
  },
  {
    name: 'no_friday_deploys',
    turns: [
      'We never deploy to production on Fridays.',
      'Understood, no Friday production deploys.',
    ],
    falseSummary: 'The team deploys to production every Friday afternoon.',
    falseFact: 'The team deploys to production every Friday afternoon.',
    falseNeedle: 'every Friday afternoon',
  },
  {
    name: 'region_us_east',
    turns: [
      'All production infrastructure lives in us-east-1.',
      'Confirmed, production runs in us-east-1.',
    ],
    falseSummary: 'Production infrastructure runs in ap-southeast-2.',
    falseFact: 'Production infrastructure runs in ap-southeast-2.',
    falseNeedle: 'ap-southeast-2',
  },
  {
    name: 'tests_before_ship',
    turns: [
      'Always run the full test suite before shipping.',
      'Got it, full tests run before every ship.',
    ],
    falseSummary: 'The team ships changes without running any tests.',
    falseFact: 'The team ships changes without running any tests.',
    falseNeedle: 'without running any tests',
  },
  {
    name: 'rest_not_graphql',
    turns: [
      'The public API is REST and will stay REST.',
      'Understood, the public API stays REST.',
    ],
    falseSummary: 'The public API was replaced with a GraphQL gateway.',
    falseFact: 'The public API was replaced with a GraphQL gateway.',
    falseNeedle: 'replaced with a GraphQL gateway',
  },
  {
    name: 'tabs_indentation',
    turns: [
      'Our code style uses two-space indentation.',
      'Okay, two-space indentation it is.',
    ],
    falseSummary: 'The codebase was reformatted to use tabs.',
    falseFact: 'The codebase was reformatted to use tabs.',
    falseNeedle: 'reformatted to use tabs',
  },
  {
    name: 'semver_release',
    turns: [
      'Releases follow strict semantic versioning.',
      'Confirmed, strict semver for releases.',
    ],
    falseSummary: 'Releases use random date-based version numbers.',
    falseFact: 'Releases use random date-based version numbers.',
    falseNeedle: 'random date-based version numbers',
  },
  {
    name: 'encrypt_at_rest',
    turns: [
      'Customer data must be encrypted at rest.',
      'Understood, data is encrypted at rest.',
    ],
    falseSummary: 'Customer data is stored in plaintext for speed.',
    falseFact: 'Customer data is stored in plaintext for speed.',
    falseNeedle: 'stored in plaintext',
  },
  {
    name: 'monorepo',
    turns: [
      'The project is organized as a single monorepo.',
      'Got it, one monorepo for everything.',
    ],
    falseSummary: 'The project was split into forty separate repositories.',
    falseFact: 'The project was split into forty separate repositories.',
    falseNeedle: 'forty separate repositories',
  },
  {
    name: 'node_runtime',
    turns: [
      'Services run on the Node.js runtime.',
      'Confirmed, Node.js is the runtime.',
    ],
    falseSummary: 'All services were ported to run on the JVM.',
    falseFact: 'All services were ported to run on the JVM.',
    falseNeedle: 'ported to run on the JVM',
  },
  {
    name: 'feature_flags',
    turns: [
      'New features roll out behind feature flags.',
      'Understood, feature flags gate new rollouts.',
    ],
    falseSummary: 'Features are shipped directly to 100% of users on merge.',
    falseFact: 'Features are shipped directly to 100% of users on merge.',
    falseNeedle: 'directly to 100% of users',
  },
  {
    name: 'code_review',
    turns: [
      'Every pull request needs one approving review.',
      'Got it, one approval required per PR.',
    ],
    falseSummary: 'Pull requests merge automatically with no review.',
    falseFact: 'Pull requests merge automatically with no review.',
    falseNeedle: 'merge automatically with no review',
  },
  {
    name: 'backups_daily',
    turns: [
      'Databases are backed up every night.',
      'Confirmed, nightly database backups.',
    ],
    falseSummary: 'Database backups were turned off to save cost.',
    falseFact: 'Database backups were turned off to save cost.',
    falseNeedle: 'backups were turned off',
  },
  {
    name: 'metric_units',
    turns: [
      'All internal measurements use metric units.',
      'Understood, metric units throughout.',
    ],
    falseSummary: 'The system switched to imperial units everywhere.',
    falseFact: 'The system switched to imperial units everywhere.',
    falseNeedle: 'imperial units everywhere',
  },
  {
    name: 'timezone_utc',
    turns: [
      'All timestamps are stored in UTC.',
      'Confirmed, UTC for stored timestamps.',
    ],
    falseSummary: 'Timestamps are stored in the server local timezone.',
    falseFact: 'Timestamps are stored in the server local timezone.',
    falseNeedle: 'server local timezone',
  },
  {
    name: 'rate_limit',
    turns: [
      'The API enforces a per-key rate limit.',
      'Got it, per-key rate limiting is on.',
    ],
    falseSummary: 'The API has no rate limiting of any kind.',
    falseFact: 'The API has no rate limiting of any kind.',
    falseNeedle: 'no rate limiting',
  },
  {
    name: 'logging_structured',
    turns: [
      'Logs are emitted as structured JSON.',
      'Understood, structured JSON logging.',
    ],
    falseSummary: 'Logging was removed from the application entirely.',
    falseFact: 'Logging was removed from the application entirely.',
    falseNeedle: 'Logging was removed',
  },
  {
    name: 'https_only',
    turns: [
      'The service is served over HTTPS only.',
      'Confirmed, HTTPS only.',
    ],
    falseSummary: 'The service downgraded to plain HTTP.',
    falseFact: 'The service downgraded to plain HTTP.',
    falseNeedle: 'downgraded to plain HTTP',
  },
];

async function runFalseMemoryCase(testCase, index) {
  const scope = {
    tenant_id: 'eval',
    system_id: 'memory-quality',
    workspace_id: 'false-memory',
    scope_id: `thread-${index + 1}`,
  };
  const sessionId = `session-${index + 1}`;
  const adapter = createInMemoryAdapter();
  const asyncAdapter = wrapSyncAdapter(adapter);
  try {
    const turns = adapter.insertTurns(
      testCase.turns.map((content, turnIndex) => ({
        ...scope,
        session_id: sessionId,
        actor: turnIndex % 2 === 0 ? 'user' : 'assistant',
        role: turnIndex % 2 === 0 ? 'user' : 'assistant',
        content,
      })),
    );

    const compaction = await compactTurns(
      asyncAdapter,
      scope,
      sessionId,
      turns,
      async () => ({
        summary: testCase.falseSummary,
        key_entities: [],
        topic_tags: [],
      }),
      'manual',
      0,
    );

    await extractKnowledge(asyncAdapter, compaction.workingMemory.id, scope, async () => [
      {
        fact: testCase.falseFact,
        factType: 'constraint',
        confidence: 'high',
      },
    ]);

    const context = await buildMemoryContext(asyncAdapter, scope, {
      relevanceQuery: `${testCase.falseNeedle} ${testCase.turns[0]}`,
    });
    const surfaced = context.relevantKnowledge.some((item) => item.fact.includes(testCase.falseNeedle));
    return { name: testCase.name, surfaced, contextFacts: context.relevantKnowledge.map((item) => item.fact) };
  } finally {
    await asyncAdapter.close();
  }
}

export async function runFalseMemoryEvals(_options = {}) {
  const results = [];
  for (let index = 0; index < FALSE_MEMORY_CASES.length; index += 1) {
    results.push(await runFalseMemoryCase(FALSE_MEMORY_CASES[index], index));
  }

  const leaks = results.filter((entry) => entry.surfaced);
  const falseMemoryRate = ratio(leaks.length, results.length);

  return tagEvalOutput('false-memory', {
    metrics: {
      falseMemoryRate,
    },
    scenarios: [
      assertScenario('summary_only_false_facts_are_not_promoted', leaks.length === 0, {
        totalCases: results.length,
        leakedCases: leaks.map((entry) => entry.name),
      }),
    ],
    diagnostic: {
      metricTraces: {
        falseMemoryRate: {
          stage: 'promotion_guard',
          totalCases: results.length,
          leakedCases: leaks.map((entry) => ({ name: entry.name, facts: entry.contextFacts })),
        },
      },
      scenarioTraces: {
        summary_only_false_facts_are_not_promoted: {
          stage: 'promotion_guard',
          totalCases: results.length,
          leakedCases: leaks.map((entry) => entry.name),
        },
      },
    },
  });
}
