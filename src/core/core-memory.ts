import type { MemoryScope } from '../contracts/identity.js';
import type { AsyncStorageAdapter } from '../contracts/async-storage.js';
import type { KnowledgeMemory } from '../contracts/types.js';
import type { CoreMemoryBundle, CoreMemoryOptions } from '../contracts/core-memory.js';
import { estimateTokens } from './tokens.js';


function sectionTokens(facts: KnowledgeMemory[]): number {
  return facts.reduce((sum, f) => sum + estimateTokens(f.fact), 0);
}

/**
 * Build a token-budgeted core memory bundle from existing storage.
 *
 * Deterministic ordering: identity → constraints → norms → work → playbook.
 * Overflow strategy controls trimming behavior:
 * - 'truncate' (default): trims all sections including constraints/identity as last resort.
 * - 'prioritize': trims playbook → work → norms only; preserves identity and constraints.
 * - 'error': trims like 'truncate' but throws if budget is still exceeded.
 */
export async function getCoreMemory(
  adapter: AsyncStorageAdapter,
  scope: MemoryScope,
  options: CoreMemoryOptions = {},
): Promise<CoreMemoryBundle> {
  const tokenBudget = options.tokenBudget ?? 1500;

  // Fetch all active knowledge for this scope
  const allKnowledge = await adapter.getActiveKnowledgeMemory(scope);

  // Filter to trusted knowledge only
  const trusted = allKnowledge.filter(
    (km) => km.knowledge_state === 'trusted',
  );

  // Classify into sections
  // Sort by trust_score descending, then id ascending for deterministic tie-breaking
  const deterministic = (a: KnowledgeMemory, b: KnowledgeMemory) =>
    b.trust_score - a.trust_score || a.id - b.id;

  const identity = trusted
    .filter((km) => km.knowledge_class === 'identity')
    .sort(deterministic);

  const constraints = trusted
    .filter((km) => km.knowledge_class === 'constraint' || km.knowledge_class === 'anti_pattern')
    .sort(deterministic);

  const norms = trusted
    .filter(
      (km) =>
        km.knowledge_class !== 'identity' &&
        km.knowledge_class !== 'constraint' &&
        km.knowledge_class !== 'anti_pattern' &&
        km.knowledge_class !== 'procedure',
    )
    .sort(deterministic);

  // Work items (sorted by id for deterministic ordering across adapters)
  const workItems = (await adapter.getActiveWorkItems(scope))
    .sort((a, b) => a.id - b.id);
  // Only include active playbooks (not drafts), sorted deterministically
  const playbooks = (await adapter.getActivePlaybooks(scope))
    .filter((p) => p.status === 'active')
    .sort((a, b) => b.revision_count - a.revision_count || a.id - b.id);
  const topPlaybook = playbooks.length > 0 ? playbooks[0] : null;

  // Apply includeClasses filter if specified
  const filterByClass = (facts: KnowledgeMemory[]) => {
    if (!options.includeClasses || options.includeClasses.length === 0) return facts;
    return facts.filter((km) => options.includeClasses!.includes(km.knowledge_class));
  };

  let filteredIdentity = filterByClass(identity);
  let filteredConstraints = filterByClass(constraints);
  let filteredNorms = filterByClass(norms);
  let filteredWorkItems = [...workItems];
  let filteredTopPlaybook = topPlaybook;

  // Calculate token estimate per section
  const workTokens = () => filteredWorkItems.reduce((s, w) => s + estimateTokens(w.title + (w.detail ?? '')), 0);
  const playbookTokens = () =>
    filteredTopPlaybook
      ? estimateTokens(filteredTopPlaybook.title + filteredTopPlaybook.description + filteredTopPlaybook.instructions)
      : 0;
  const totalTokens = () =>
    sectionTokens(filteredIdentity) +
    sectionTokens(filteredConstraints) +
    sectionTokens(filteredNorms) +
    workTokens() +
    playbookTokens();

  const overflowStrategy = options.overflowStrategy ?? 'truncate';

  // Overflow trimming by class priority (highest priority number trimmed first)
  // Playbook → work items → norms → constraints → identity
  if (totalTokens() > tokenBudget) {
    // Trim playbook first
    if (filteredTopPlaybook && totalTokens() > tokenBudget) {
      filteredTopPlaybook = null;
    }
    // Trim work items
    while (filteredWorkItems.length > 0 && totalTokens() > tokenBudget) {
      filteredWorkItems.pop();
    }
    // Trim norms (lowest trust first)
    while (filteredNorms.length > 0 && totalTokens() > tokenBudget) {
      filteredNorms.pop();
    }
    // 'prioritize' preserves identity and constraints; 'truncate'/'error' trim them as fallback
    if (overflowStrategy !== 'prioritize') {
      // Trim constraints (lowest trust first) as fallback
      while (filteredConstraints.length > 0 && totalTokens() > tokenBudget) {
        filteredConstraints.pop();
      }
      // Trim identity (lowest trust first) as last resort
      while (filteredIdentity.length > 0 && totalTokens() > tokenBudget) {
        filteredIdentity.pop();
      }
    }
  }

  if (overflowStrategy === 'error' && totalTokens() > tokenBudget) {
    throw new Error(`Core memory exceeds token budget: ${totalTokens()} > ${tokenBudget}`);
  }

  const tokenEstimate = totalTokens();

  return {
    identity: filteredIdentity,
    constraints: filteredConstraints,
    norms: filteredNorms,
    workItems: filteredWorkItems,
    topPlaybook: filteredTopPlaybook,
    tokenEstimate,
    generatedAt: Math.floor(Date.now() / 1000),
  };
}
