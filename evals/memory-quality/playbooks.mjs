import { createSQLiteAdapter } from '../../dist/adapters/sqlite/index.js';
import { wrapSyncAdapter } from '../../dist/adapters/sync-to-async.js';
import { revisePlaybook } from '../../dist/core/playbook.js';
import { assertScenario, ratio, tagEvalOutput } from './shared.mjs';

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function makeScope(overrides = {}) {
  return {
    tenant_id: 'eval',
    system_id: 'memory-quality',
    workspace_id: 'playbooks',
    scope_id: 'thread-1',
    ...overrides,
  };
}

// ---------- Metric 1: playbook_creation_quality ----------
async function evalCreationQuality(adapter, asyncAdapter, scope) {
  // Create a playbook with full metadata
  const playbook = await asyncAdapter.insertPlaybook({
    ...scope,
    title: 'Deploy to staging',
    description: 'Standard procedure for deploying services to the staging environment.',
    instructions: '1. Run tests locally\n2. Push to staging branch\n3. Verify health checks\n4. Run integration tests',
    references: ['docs/deployment.md', 'scripts/deploy.sh'],
    templates: ['deploy-template.yaml'],
    scripts: ['npm run deploy:staging'],
    assets: [],
    tags: ['deployment', 'staging', 'devops'],
    status: 'active',
    source_session_id: 'session-deploy-1',
  });

  // Verify all fields are populated and correct
  const checks = [
    playbook.id > 0,
    playbook.title === 'Deploy to staging',
    playbook.description.includes('staging'),
    playbook.instructions.includes('health checks'),
    Array.isArray(playbook.references) && playbook.references.length === 2,
    Array.isArray(playbook.templates) && playbook.templates.length === 1,
    Array.isArray(playbook.scripts) && playbook.scripts.length === 1,
    Array.isArray(playbook.tags) && playbook.tags.includes('deployment'),
    playbook.status === 'active',
    playbook.source_session_id === 'session-deploy-1',
    playbook.revision_count === 0,
    playbook.use_count === 0,
    typeof playbook.created_at === 'number',
    typeof playbook.updated_at === 'number',
  ];

  const passedCount = checks.filter(Boolean).length;
  const score = ratio(passedCount, checks.length);

  return {
    metric: score,
    passed: score >= 0.9,
    playbook,
    checksTotal: checks.length,
    checksPassed: passedCount,
  };
}

// ---------- Metric 2: playbook_retrieval_relevance ----------
async function evalRetrievalRelevance(adapter, asyncAdapter, scope) {
  // Create a second unrelated playbook
  await asyncAdapter.insertPlaybook({
    ...scope,
    title: 'Update billing invoices',
    description: 'Procedure for updating billing invoice templates.',
    instructions: '1. Open invoice template\n2. Update fields\n3. Save and publish',
    tags: ['billing', 'invoices'],
    status: 'active',
  });

  // Search for deployment-related playbooks
  const results = await asyncAdapter.searchPlaybooks(scope, 'deploy staging', { limit: 10 });

  // The deployment playbook should rank higher than billing
  const hasResults = results.length > 0;
  const topResult = results[0];
  const topIsRelevant = topResult && topResult.item.title.includes('Deploy');

  // Verify all results are well-formed
  const allWellFormed = results.every(
    (r) => r.item && typeof r.item.id === 'number' && typeof r.rank === 'number',
  );

  // Check getActivePlaybooks returns both
  const active = await asyncAdapter.getActivePlaybooks(scope);
  const activeCountCorrect = active.length >= 2;

  const checks = [hasResults, topIsRelevant, allWellFormed, activeCountCorrect];
  const score = ratio(checks.filter(Boolean).length, checks.length);

  return {
    metric: score,
    passed: score >= 0.75,
    resultCount: results.length,
    topTitle: topResult?.item?.title,
    activeCount: active.length,
  };
}

// ---------- Metric 3: playbook_revision_continuity ----------
async function evalRevisionContinuity(adapter, asyncAdapter, scope) {
  // Get the deployment playbook
  const active = await asyncAdapter.getActivePlaybooks(scope);
  const deployPlaybook = active.find((p) => p.title.includes('Deploy'));
  if (!deployPlaybook) {
    return { metric: 0, passed: false, error: 'Deploy playbook not found' };
  }

  const originalInstructions = deployPlaybook.instructions;

  // Record a use first
  await asyncAdapter.recordPlaybookUse(deployPlaybook.id);
  const afterUse = await asyncAdapter.getPlaybookById(deployPlaybook.id);
  const useRecorded = afterUse && afterUse.use_count === 1;

  // Revise using the real revisePlaybook flow (not raw insertPlaybookRevision)
  const newInstructions = '1. Run tests locally\n2. Push to staging branch\n3. Verify health checks\n4. Run integration tests\n5. Notify team on Slack';
  const result = await revisePlaybook(
    asyncAdapter,
    scope,
    deployPlaybook.id,
    newInstructions,
    'Added Slack notification step',
    'session-deploy-2',
  );

  // Verify revision preserved the OLD instructions
  const revisionPreservedOld =
    result.revision.instructions === originalInstructions;

  // Verify the playbook was updated with NEW instructions
  const playbookUpdated =
    result.playbook.instructions === newInstructions;

  // Verify revision metadata
  const revisionMetadataValid =
    result.revision.playbook_id === deployPlaybook.id &&
    result.revision.revision_reason === 'Added Slack notification step' &&
    result.revision.source_session_id === 'session-deploy-2';

  // Fetch revision history and verify
  const revisions = await asyncAdapter.getPlaybookRevisions(deployPlaybook.id);
  const hasRevisionHistory = revisions.length >= 1;

  // Verify the playbook getById returns updated version
  const fetched = await asyncAdapter.getPlaybookById(deployPlaybook.id);
  const fetchedHasNewInstructions = fetched && fetched.instructions === newInstructions;

  const checks = [useRecorded, revisionPreservedOld, playbookUpdated, revisionMetadataValid, hasRevisionHistory, fetchedHasNewInstructions];
  const score = ratio(checks.filter(Boolean).length, checks.length);

  return {
    metric: score,
    passed: score >= 0.9,
    useCount: afterUse?.use_count,
    revisionPreservedOld,
    playbookUpdated,
    revisionCount: revisions.length,
  };
}

export async function runPlaybookEvals(_options = {}) {
  const scope = makeScope();
  const adapter = createSQLiteAdapter(':memory:');
  const asyncAdapter = wrapSyncAdapter(adapter);

  try {
    const creation = await evalCreationQuality(adapter, asyncAdapter, scope);
    const retrieval = await evalRetrievalRelevance(adapter, asyncAdapter, scope);
    const revision = await evalRevisionContinuity(adapter, asyncAdapter, scope);

    const metrics = {
      playbookCreationQuality: creation.metric,
      playbookRetrievalRelevance: retrieval.metric,
      playbookRevisionContinuity: revision.metric,
    };

    return tagEvalOutput('playbooks', {
      metrics,
      scenarios: [
        assertScenario('playbook_creation_produces_complete_record', creation.passed, {
          checksPassed: creation.checksPassed,
          checksTotal: creation.checksTotal,
        }),
        assertScenario('playbook_search_returns_relevant_results', retrieval.passed, {
          resultCount: retrieval.resultCount,
          topTitle: retrieval.topTitle,
        }),
        assertScenario('playbook_revision_maintains_continuity', revision.passed, {
          useCount: revision.useCount,
          revisionCount: revision.revisionCount,
        }),
      ],
      diagnostic: {
        metricTraces: {
          playbookCreationQuality: { stage: 'insert_playbook' },
          playbookRetrievalRelevance: {
            stage: 'search_playbooks',
            resultCount: retrieval.resultCount,
            topTitle: retrieval.topTitle,
          },
          playbookRevisionContinuity: {
            stage: 'revise_playbook',
            useCount: revision.useCount,
            revisionCount: revision.revisionCount,
            revisionPreservedOld: revision.revisionPreservedOld,
            playbookUpdated: revision.playbookUpdated,
          },
        },
      },
    });
  } finally {
    adapter.close();
  }
}
