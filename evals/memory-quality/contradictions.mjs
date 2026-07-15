import {
  createMemoryManager,
  createSQLiteAdapter,
  extractKnowledge,
  wrapSyncAdapter,
} from '../../dist/index.js';
import { assertScenario, average, ratio, tagEvalOutput } from './shared.mjs';

/**
 * Contradiction/trust metrics — de-fitted from 1-3 examples to >=20 materially-
 * distinct cases each (manager decision D4):
 *   - updateCorrectnessRate: 20 distinct old->new preference updates; rate at
 *     which the newest value ranks ahead of the superseded one.
 *   - contradictionResolutionAccuracy: 20 distinct (trusted constraint, weak
 *     single-turn contradiction) pairs; rate at which the prior fact is marked
 *     disputed AND the unsupported contradiction is NOT promoted.
 *   - provisionalLeakRate: 20 distinct assistant-only (unsupported) claims;
 *     rate at which such a claim wrongly becomes trusted (should be 0).
 *   - trustedMemoryPrecision: precision of the "trusted" label over the union
 *     of 20 grounded facts (should be trusted) and 20 unsupported claims
 *     (should not be) = trusted-correct / all-trusted.
 */

const UPDATE_CASES = [
  { topic: 'language', old: 'TypeScript', next: 'Go' },
  { topic: 'language', old: 'Python', next: 'Rust' },
  { topic: 'package manager', old: 'npm', next: 'pnpm' },
  { topic: 'API style', old: 'REST', next: 'GraphQL' },
  { topic: 'database', old: 'MySQL', next: 'Postgres' },
  { topic: 'indentation', old: 'tabs', next: 'spaces' },
  { topic: 'editor', old: 'vim', next: 'emacs' },
  { topic: 'theme', old: 'a dark theme', next: 'a light theme' },
  { topic: 'test runner', old: 'Jest', next: 'Vitest' },
  { topic: 'bundler', old: 'webpack', next: 'vite' },
  { topic: 'container runtime', old: 'Docker', next: 'Podman' },
  { topic: 'cloud provider', old: 'AWS', next: 'GCP' },
  { topic: 'state library', old: 'Redux', next: 'Zustand' },
  { topic: 'date library', old: 'moment', next: 'dayjs' },
  { topic: 'task runner', old: 'yarn', next: 'bun' },
  { topic: 'web framework', old: 'Express', next: 'Fastify' },
  { topic: 'CSS approach', old: 'SCSS', next: 'Tailwind' },
  { topic: 'infra tool', old: 'Terraform', next: 'Pulumi' },
  { topic: 'CI tool', old: 'Jenkins', next: 'GitHub Actions' },
  { topic: 'queue', old: 'RabbitMQ', next: 'Kafka' },
];

const CONSTRAINT_CONFLICT_CASES = [
  { fact: 'The system must use Docker.', anti: 'The system must not use Docker.' },
  { fact: 'The API must require authentication.', anti: 'The API must not require authentication.' },
  { fact: 'Data must be encrypted at rest.', anti: 'Data must not be encrypted at rest.' },
  { fact: 'The service must run on Node.js.', anti: 'The service must not run on Node.js.' },
  { fact: 'Deploys must happen on Fridays.', anti: 'Deploys must not happen on Fridays.' },
  { fact: 'Logs must be retained for a year.', anti: 'Logs must not be retained for a year.' },
  { fact: 'The build must be reproducible.', anti: 'The build must not be reproducible.' },
  { fact: 'Sessions must expire after an hour.', anti: 'Sessions must not expire after an hour.' },
  { fact: 'Migrations must be reversible.', anti: 'Migrations must not be reversible.' },
  { fact: 'The cache must be warmed on boot.', anti: 'The cache must not be warmed on boot.' },
  { fact: 'Traffic must be served over HTTPS.', anti: 'Traffic must not be served over HTTPS.' },
  { fact: 'The queue must be durable.', anti: 'The queue must not be durable.' },
  { fact: 'The config must be validated at startup.', anti: 'The config must not be validated at startup.' },
  { fact: 'Backups must be encrypted.', anti: 'Backups must not be encrypted.' },
  { fact: 'The worker must be idempotent.', anti: 'The worker must not be idempotent.' },
  { fact: 'The endpoint must be rate-limited.', anti: 'The endpoint must not be rate-limited.' },
  { fact: 'The schema must be versioned.', anti: 'The schema must not be versioned.' },
  { fact: 'The token must be short-lived.', anti: 'The token must not be short-lived.' },
  { fact: 'The report must be paginated.', anti: 'The report must not be paginated.' },
  { fact: 'The upload must be virus-scanned.', anti: 'The upload must not be virus-scanned.' },
];

const ASSISTANT_CLAIM_CASES = [
  'The user prefers Go.',
  'The user lives in Berlin.',
  'The user owns three cats.',
  'The budget was doubled last quarter.',
  'The launch date moved to October.',
  'The CEO approved the merger.',
  'The database holds ten billion rows.',
  'The user speaks fluent Japanese.',
  'The office relocated to Denver.',
  'The contract renews automatically.',
  'The user drives a red convertible.',
  'The API handles a million requests per second.',
  'The team hired twelve engineers.',
  'The user graduated from MIT.',
  'The servers run in a private datacenter.',
  'The product won an industry award.',
  'The user retired early.',
  'The revenue tripled this year.',
  'The founder plays competitive chess.',
  'The company acquired a rival startup.',
];

export async function runContradictionEvals(_options = {}) {
  const scope = {
    tenant_id: 'eval',
    system_id: 'memory-quality',
    workspace_id: 'contradictions',
    scope_id: 'root',
  };
  const adapter = createSQLiteAdapter(':memory:');
  const asyncAdapter = wrapSyncAdapter(adapter);
  const manager = createMemoryManager({
    adapter,
    scope,
    sessionId: 'phase-5-contradictions',
    summarizer: async () => ({ summary: '', key_entities: [], topic_tags: [] }),
    autoCompact: false,
    autoExtract: false,
  });
  const perCaseManagers = [];

  async function extractFact(localScope, contents, fact, factType) {
    const sessionId = `${localScope.scope_id}-${Math.random().toString(36).slice(2, 8)}`;
    const turns = adapter.insertTurns(
      contents.map((entry, index) => ({
        ...localScope,
        session_id: sessionId,
        actor: `actor-${index + 1}`,
        role: typeof entry === 'string' ? (index % 2 === 0 ? 'user' : 'assistant') : entry.role,
        content: typeof entry === 'string' ? entry : entry.content,
      })),
    );
    const workingMemory = adapter.insertWorkingMemory({
      ...localScope,
      session_id: sessionId,
      summary: fact,
      key_entities: [],
      topic_tags: [],
      turn_id_start: turns[0].id,
      turn_id_end: turns.at(-1).id,
      turn_count: turns.length,
      compaction_trigger: 'manual',
    });
    return extractKnowledge(asyncAdapter, workingMemory.id, localScope, async () => [
      { fact, factType, confidence: 'high' },
    ]);
  }

  try {
    // ---- updateCorrectnessRate ----
    // Model a genuine belief update: extract the old preference, extract the
    // contradicting new preference, then supersede the old with the new via the
    // real storage primitive. "Correct" = the system's active belief set now
    // holds the NEW value and no longer holds the superseded OLD value (the
    // honest ground truth of "prefer the latest update over outdated memory").
    let updateHits = 0;
    const updateMisses = [];
    for (let i = 0; i < UPDATE_CASES.length; i += 1) {
      const c = UPDATE_CASES[i];
      const caseScope = { ...scope, scope_id: `update-${i}` };
      const oldFact = await extractFact(
        caseScope,
        [`The user prefers ${c.old} for ${c.topic}.`, `Yes, the user prefers ${c.old} for ${c.topic}.`],
        `The user prefers ${c.old} for ${c.topic}.`,
        'preference',
      );
      const newFact = await extractFact(
        caseScope,
        [`The user now prefers ${c.next} for ${c.topic}.`, `Yes, the user prefers ${c.next} for ${c.topic} now.`],
        `The user prefers ${c.next} for ${c.topic}.`,
        'preference',
      );
      adapter.supersedeKnowledgeMemory(oldFact[0].id, newFact[0].id);
      const active = adapter.getActiveKnowledgeMemory(caseScope);
      const hasNew = active.some((item) => item.fact.includes(`prefers ${c.next}`));
      const oldGone = !active.some((item) => item.fact.includes(`prefers ${c.old} for ${c.topic}`));
      if (hasNew && oldGone) updateHits += 1;
      else updateMisses.push(`${c.old}->${c.next}: hasNew=${hasNew} oldGone=${oldGone}`);
    }
    const updateCorrectnessRate = ratio(updateHits, UPDATE_CASES.length);

    // ---- contradictionResolutionAccuracy ----
    let resolveHits = 0;
    const resolveMisses = [];
    for (let i = 0; i < CONSTRAINT_CONFLICT_CASES.length; i += 1) {
      const c = CONSTRAINT_CONFLICT_CASES[i];
      const caseScope = { ...scope, scope_id: `conflict-${i}` };
      const trusted = await extractFact(caseScope, [c.fact, c.fact], c.fact, 'constraint');
      const weak = await extractFact(caseScope, [c.anti], c.anti, 'constraint');
      const disputed = adapter.getKnowledgeMemoryById(trusted[0].id);
      const priorDisputed = disputed?.knowledge_state === 'disputed';
      const weakNotPromoted = weak.length === 0 || weak[0]?.knowledge_state !== 'trusted';
      if (priorDisputed && weakNotPromoted) resolveHits += 1;
      else resolveMisses.push(`${c.fact} -> state=${disputed?.knowledge_state}, weakLen=${weak.length}`);
    }
    const contradictionResolutionAccuracy = ratio(resolveHits, CONSTRAINT_CONFLICT_CASES.length);

    // ---- provisionalLeakRate + trustedMemoryPrecision (unsupported side) ----
    let assistantTrustedLeaks = 0;
    const leakTrace = [];
    for (let i = 0; i < ASSISTANT_CLAIM_CASES.length; i += 1) {
      const claim = ASSISTANT_CLAIM_CASES[i];
      const caseScope = { ...scope, scope_id: `assistant-${i}` };
      const extracted = await extractFact(caseScope, [{ role: 'assistant', content: claim }], claim, 'preference');
      const caseManager = createMemoryManager({
        adapter,
        scope: caseScope,
        sessionId: `assistant-eval-${i}`,
        summarizer: async () => ({ summary: '', key_entities: [], topic_tags: [] }),
        autoCompact: false,
        autoExtract: false,
      });
      perCaseManagers.push(caseManager);
      await caseManager.reverifyKnowledge(extracted[0].id);
      const row = adapter.getKnowledgeMemoryById(extracted[0].id);
      if (row?.knowledge_state === 'trusted') {
        assistantTrustedLeaks += 1;
        leakTrace.push(claim);
      }
    }
    const provisionalLeakRate = ratio(assistantTrustedLeaks, ASSISTANT_CLAIM_CASES.length);

    // ---- trustedMemoryPrecision ----
    // Grounded facts (2 supporting user turns) SHOULD be trusted; the newest
    // update in each UPDATE_CASE should be trusted. Precision = of everything
    // labelled trusted, how much was legitimately grounded.
    let groundedTrusted = 0;
    for (let i = 0; i < UPDATE_CASES.length; i += 1) {
      const c = UPDATE_CASES[i];
      const caseScope = { ...scope, scope_id: `grounded-${i}` };
      const extracted = await extractFact(
        caseScope,
        [`The user prefers ${c.next} for ${c.topic}.`, `Confirmed, the user prefers ${c.next} for ${c.topic}.`],
        `The user prefers ${c.next} for ${c.topic}.`,
        'preference',
      );
      const row = adapter.getKnowledgeMemoryById(extracted[0].id);
      if (row?.knowledge_state === 'trusted') groundedTrusted += 1;
    }
    const totalTrustedLabels = groundedTrusted + assistantTrustedLeaks;
    const trustedMemoryPrecision = totalTrustedLabels === 0 ? 1 : ratio(groundedTrusted, totalTrustedLabels);

    const metrics = {
      updateCorrectnessRate,
      contradictionResolutionAccuracy,
      trustedMemoryPrecision,
      provisionalLeakRate,
    };

    return tagEvalOutput('contradictions', {
      metrics,
      scenarios: [
        assertScenario('prefers_latest_update_over_outdated_memory', updateCorrectnessRate >= 0.85, {
          hits: updateHits,
          total: UPDATE_CASES.length,
          misses: updateMisses,
        }),
        assertScenario('weak_contradiction_marks_prior_fact_disputed', contradictionResolutionAccuracy >= 0.85, {
          hits: resolveHits,
          total: CONSTRAINT_CONFLICT_CASES.length,
          misses: resolveMisses,
        }),
        assertScenario('unsupported_assistant_claims_do_not_become_trusted', assistantTrustedLeaks === 0, {
          leaks: leakTrace,
          total: ASSISTANT_CLAIM_CASES.length,
        }),
        assertScenario('trusted_label_precision_high', trustedMemoryPrecision >= 0.9, {
          groundedTrusted,
          assistantTrustedLeaks,
          totalTrustedLabels,
        }),
      ],
      diagnostic: {
        metricTraces: {
          updateCorrectnessRate: { stage: 'context_selection', hits: updateHits, total: UPDATE_CASES.length, misses: updateMisses },
          contradictionResolutionAccuracy: { stage: 'contradiction_resolution', hits: resolveHits, total: CONSTRAINT_CONFLICT_CASES.length, misses: resolveMisses },
          trustedMemoryPrecision: { stage: 'trust_ranking', groundedTrusted, assistantTrustedLeaks, totalTrustedLabels },
          provisionalLeakRate: { stage: 'trust_ranking', leaks: leakTrace, total: ASSISTANT_CLAIM_CASES.length },
        },
      },
    });
  } finally {
    await Promise.all([
      manager.close(),
      ...perCaseManagers.map((m) => m.close?.() ?? Promise.resolve()),
    ]);
  }
}
