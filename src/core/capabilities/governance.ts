import { createHash } from 'crypto';
import { ValidationError } from '../../contracts/errors.js';
import type {
  AppliedContextContract,
  ContextContract,
  ContextEscalationChange,
  ContextEscalationDecision,
  ContextEscalationPolicy,
  ContextEscalationRuleDecision,
  ContextGovernanceSnapshot,
  ContextInvariant,
  ContextRequest,
  ContextRequestResolution,
  ContextWarning,
} from '../../contracts/context-contract.js';
import { DEFAULT_CONTEXT_POLICY } from '../../contracts/policy.js';
import { resolveContextScopeLevel } from '../context.js';
import {
  cloneContextContract,
  cloneContextEscalationPolicy,
  cloneContextInvariant,
  mergeContextContract,
  mergeContextInvariants,
  normalizeContextEscalationPolicy,
  scopeLevelRank,
  viewRank,
} from '../manager-support.js';
import type { CapabilityContext } from './context.js';
import type { ContextExpansionOptions } from '../manager-types.js';

/**
 * Governance namespace (Phase 6.2): context contracts, invariants, and the
 * escalation policy. This capability OWNS the mutable governance cache
 * (default/named contracts, invariants, escalation policy, and the lazy-load
 * latch) — previously closure state in the manager factory (item 3). The
 * manager's context-assembly helpers reach governance state only through the
 * {@link GovernanceInternal} accessor returned alongside the namespace.
 */
export interface GovernanceCapability {
  getContextGovernance(): Promise<ContextGovernanceSnapshot>;
  setDefaultContextContract(contract: ContextContract | null): Promise<ContextContract | null>;
  putContextContract(name: string, contract: ContextContract): Promise<ContextContract>;
  deleteContextContract(name: string): Promise<boolean>;
  putContextInvariant(invariant: ContextInvariant): Promise<ContextInvariant>;
  deleteContextInvariant(id: string): Promise<boolean>;
  getContextEscalationPolicy(): Promise<ContextGovernanceSnapshot['escalationPolicy']>;
  setContextEscalationPolicy(
    policy: ContextEscalationPolicy,
  ): Promise<ContextGovernanceSnapshot['escalationPolicy']>;
  requestContextExpansion(
    request: ContextRequest,
    options?: ContextExpansionOptions,
  ): Promise<ContextRequestResolution>;
}

/**
 * The subset of governance internals the manager's context-assembly helpers
 * consult while resolving a query's contract/invariants.
 */
export interface GovernanceInternal {
  ensureGovernanceLoaded(): Promise<void>;
  resolveContextContractReference(
    reference?: import('../../contracts/context-contract.js').ContextContractReference,
  ): ContextContract | undefined;
  getManagedInvariants(): ContextInvariant[];
}

export interface GovernanceModule {
  namespace: GovernanceCapability;
  internal: GovernanceInternal;
}

export type GovernanceContext = Pick<CapabilityContext, 'asyncAdapter' | 'config'>;

export function createGovernanceCapability(ctx: GovernanceContext): GovernanceModule {
  const { asyncAdapter, config } = ctx;

  let defaultContextContract = cloneContextContract(config.contextContract);
  const namedContextContracts = new Map<string, ContextContract>(
    Object.entries(config.contextContracts ?? {}).map(([name, contract]) => [
      name,
      cloneContextContract({ name: contract.name ?? name, ...contract })!,
    ]),
  );
  const configuredInvariants = mergeContextInvariants(config.invariants, undefined);
  const contextInvariants = new Map<string, ContextInvariant>(
    configuredInvariants.map((invariant) => [invariant.id, cloneContextInvariant(invariant)]),
  );
  let escalationPolicy = normalizeContextEscalationPolicy(config.escalationPolicy);

  let governanceLoaded = false;
  let governanceLoadPromise: Promise<void> | null = null;

  async function ensureGovernanceLoaded(): Promise<void> {
    if (governanceLoaded) return;
    if (governanceLoadPromise) return governanceLoadPromise;
    governanceLoadPromise = (async () => {
      const persisted = await asyncAdapter.getGovernanceState?.(config.scope);
      if (persisted) {
        if (persisted.defaultContract?.state === 'set') {
          defaultContextContract = cloneContextContract(persisted.defaultContract.contract);
        } else if (persisted.defaultContract?.state === 'cleared') {
          defaultContextContract = null;
        }
        for (const [name, contract] of Object.entries(persisted.namedContracts)) {
          namedContextContracts.set(name, cloneContextContract({ name: contract.name ?? name, ...contract })!);
        }
        for (const name of persisted.deletedContractNames) {
          namedContextContracts.delete(name);
        }
        for (const inv of persisted.invariants) {
          contextInvariants.set(inv.id, cloneContextInvariant(inv));
        }
        for (const invariantId of persisted.deletedInvariantIds) {
          contextInvariants.delete(invariantId);
        }
        if (persisted.escalationPolicy) {
          escalationPolicy = normalizeContextEscalationPolicy(persisted.escalationPolicy);
        }
      }
      governanceLoaded = true;
    })();
    return governanceLoadPromise;
  }

  function resolveContextContractReference(
    reference?: import('../../contracts/context-contract.js').ContextContractReference,
  ): ContextContract | undefined {
    if (reference == null) {
      return defaultContextContract ?? undefined;
    }
    if (typeof reference === 'string') {
      const named = namedContextContracts.get(reference);
      if (!named) {
        throw new ValidationError(`Unknown context contract: ${reference}`);
      }
      return mergeContextContract(defaultContextContract ?? undefined, {
        name: named.name ?? reference,
        ...named,
      });
    }
    return mergeContextContract(defaultContextContract ?? undefined, reference);
  }

  function getManagedInvariants(): ContextInvariant[] {
    return [...contextInvariants.values()].map(cloneContextInvariant);
  }

  function getGovernanceSnapshot(): ContextGovernanceSnapshot {
    const contracts = Object.fromEntries(
      [...namedContextContracts.entries()].map(([name, contract]) => [
        name,
        cloneContextContract(contract)!,
      ]),
    );
    return {
      defaultContract: cloneContextContract(defaultContextContract),
      contracts,
      invariants: getManagedInvariants(),
      escalationPolicy: cloneContextEscalationPolicy(escalationPolicy),
    };
  }

  function materializeAppliedContextContract(contract?: ContextContract): AppliedContextContract {
    const view = contract?.view;
    const crossScopeLevel = resolveContextScopeLevel(
      contract?.crossScopeLevel ?? config.crossScopeLevel,
      view,
    );
    return {
      name: contract?.name,
      view,
      crossScopeLevel,
      tokenBudget:
        contract?.tokenBudget ??
        config.contextPolicy?.tokenBudget ??
        DEFAULT_CONTEXT_POLICY.tokenBudget,
      maxKnowledgeItems:
        contract?.maxKnowledgeItems ??
        config.contextPolicy?.maxKnowledgeItems ??
        DEFAULT_CONTEXT_POLICY.maxKnowledgeItems,
      maxRecentSummaries:
        contract?.maxRecentSummaries ??
        config.contextPolicy?.maxRecentSummaries ??
        DEFAULT_CONTEXT_POLICY.maxRecentSummaries,
      knowledgeClasses: contract?.knowledgeClasses ? [...contract.knowledgeClasses] : null,
      minimumTrustScore: contract?.minimumTrustScore ?? null,
      includeCoordinationState: contract?.includeCoordinationState ?? false,
    };
  }

  function knowledgeClassesAreBroader(
    current: AppliedContextContract['knowledgeClasses'],
    proposed: AppliedContextContract['knowledgeClasses'],
  ): boolean {
    if (current == null) return false;
    if (proposed == null) return true;
    const currentSet = new Set(current);
    return proposed.some((item) => !currentSet.has(item));
  }

  function buildContextExpansionResolution(
    request: ContextRequest,
    currentContract: ContextContract | undefined,
  ): ContextRequestResolution {
    const mergedContract = mergeContextContract(currentContract, request.contract);
    const currentApplied = currentContract ? materializeAppliedContextContract(currentContract) : null;
    const proposedApplied = materializeAppliedContextContract(mergedContract);
    const rationale: string[] = [];
    const changeKinds: ContextEscalationChange[] = [];

    if ((currentApplied?.view ? viewRank(proposedApplied.view) : 0) > viewRank(currentApplied?.view)) {
      changeKinds.push('broaden_view');
      rationale.push('Requested a broader visibility view.');
    }
    if (
      (currentApplied?.crossScopeLevel
        ? scopeLevelRank(proposedApplied.crossScopeLevel)
        : 0) > scopeLevelRank(currentApplied?.crossScopeLevel)
    ) {
      changeKinds.push('widen_scope');
      rationale.push('Requested a wider cross-scope retrieval level.');
    }
    if (
      currentApplied?.minimumTrustScore != null &&
      proposedApplied.minimumTrustScore != null &&
      proposedApplied.minimumTrustScore < currentApplied.minimumTrustScore
    ) {
      changeKinds.push('lower_minimum_trust');
      rationale.push('Requested a lower minimum trust threshold.');
    }
    if (knowledgeClassesAreBroader(currentApplied?.knowledgeClasses ?? null, proposedApplied.knowledgeClasses)) {
      changeKinds.push('broaden_knowledge_classes');
      rationale.push('Requested additional knowledge classes.');
    }
    if (
      currentApplied &&
      !currentApplied.includeCoordinationState &&
      proposedApplied.includeCoordinationState
    ) {
      changeKinds.push('include_coordination_state');
      rationale.push('Requested coordination state that is not currently exposed.');
    }
    if (
      currentApplied &&
      proposedApplied.tokenBudget > currentApplied.tokenBudget
    ) {
      changeKinds.push('increase_token_budget');
      rationale.push('Requested a larger token budget.');
    }
    if (rationale.length === 0) {
      rationale.push('Request can be satisfied within the current context boundary.');
    }
    let decision: ContextEscalationDecision = 'approved';

    if (
      escalationPolicy.maxView &&
      viewRank(proposedApplied.view) > viewRank(escalationPolicy.maxView)
    ) {
      decision = 'denied';
      rationale.push(`Policy caps visibility at ${escalationPolicy.maxView}.`);
    }
    if (
      escalationPolicy.maxScopeLevel &&
      scopeLevelRank(proposedApplied.crossScopeLevel) > scopeLevelRank(escalationPolicy.maxScopeLevel)
    ) {
      decision = 'denied';
      rationale.push(`Policy caps cross-scope retrieval at ${escalationPolicy.maxScopeLevel}.`);
    }
    if (
      escalationPolicy.maxTokenBudget != null &&
      proposedApplied.tokenBudget > escalationPolicy.maxTokenBudget
    ) {
      decision = 'denied';
      rationale.push(`Policy caps token budget at ${escalationPolicy.maxTokenBudget}.`);
    }
    if (
      escalationPolicy.minimumAllowedTrustScore != null &&
      proposedApplied.minimumTrustScore != null &&
      proposedApplied.minimumTrustScore < escalationPolicy.minimumAllowedTrustScore
    ) {
      decision = 'denied';
      rationale.push(
        `Policy does not allow trust thresholds below ${escalationPolicy.minimumAllowedTrustScore.toFixed(2)}.`,
      );
    }

    if (decision !== 'denied' && changeKinds.length > 0) {
      let strongestDecision: ContextEscalationRuleDecision = 'allow';
      for (const changeKind of changeKinds) {
        const ruleDecision = escalationPolicy.byChange?.[changeKind] ?? escalationPolicy.defaultDecision;
        if (ruleDecision === 'deny') {
          strongestDecision = 'deny';
          rationale.push(`Policy denies ${changeKind}.`);
          break;
        }
        if (ruleDecision === 'review') {
          strongestDecision = 'review';
        }
      }
      decision =
        strongestDecision === 'deny'
          ? 'denied'
          : strongestDecision === 'review'
            ? 'requires_approval'
            : 'approved';
    }

    const requiresEscalation = decision === 'requires_approval';
    const warnings: ContextWarning[] =
      decision === 'approved'
        ? []
        : [
            {
              code: 'contract_filtered',
              severity: 'warning',
              message:
                decision === 'denied'
                  ? 'This request exceeds the configured escalation policy and was denied.'
                  : 'This request broadens the current contract and requires approval by the orchestrator.',
              metadata: {
                decision,
                changeKinds,
              },
            },
          ];

    return {
      requestId: createHash('sha1')
        .update(JSON.stringify({ request, mergedContract, scope: config.scope, sessionId: config.sessionId }))
        .digest('hex')
        .slice(0, 16),
      requestedAt: Math.floor(Date.now() / 1000),
      reason: request.reason,
      note: request.note ?? null,
      currentContract: currentApplied,
      proposedContract: proposedApplied,
      proposedContractInput: mergedContract ?? {},
      changeKinds,
      decision,
      requiresEscalation,
      rationale,
      warnings,
    };
  }

  const namespace: GovernanceCapability = {
    async getContextGovernance() {
      await ensureGovernanceLoaded();
      return getGovernanceSnapshot();
    },

    async setDefaultContextContract(contract) {
      await ensureGovernanceLoaded();
      defaultContextContract = cloneContextContract(contract);
      await asyncAdapter.upsertDefaultContextContract?.(config.scope, contract);
      return cloneContextContract(defaultContextContract);
    },

    async putContextContract(name, contract) {
      await ensureGovernanceLoaded();
      if (!name.trim()) {
        throw new ValidationError('Context contract name is required');
      }
      const stored = cloneContextContract({
        ...contract,
        name: contract.name ?? name,
      })!;
      namedContextContracts.set(name, stored);
      await asyncAdapter.upsertNamedContextContract?.(config.scope, name, stored);
      return cloneContextContract(stored)!;
    },

    async deleteContextContract(name) {
      await ensureGovernanceLoaded();
      const deleted = namedContextContracts.delete(name);
      if (deleted) {
        await asyncAdapter.deleteNamedContextContract?.(config.scope, name);
      }
      return deleted;
    },

    async putContextInvariant(invariant) {
      await ensureGovernanceLoaded();
      if (!invariant.id.trim()) {
        throw new ValidationError('Context invariant id is required');
      }
      contextInvariants.set(invariant.id, cloneContextInvariant(invariant));
      await asyncAdapter.upsertContextInvariant?.(config.scope, invariant);
      return cloneContextInvariant(contextInvariants.get(invariant.id)!);
    },

    async deleteContextInvariant(id) {
      await ensureGovernanceLoaded();
      const deleted = contextInvariants.delete(id);
      if (deleted) {
        await asyncAdapter.deleteContextInvariant?.(config.scope, id);
      }
      return deleted;
    },

    async getContextEscalationPolicy() {
      await ensureGovernanceLoaded();
      return cloneContextEscalationPolicy(escalationPolicy);
    },

    async setContextEscalationPolicy(policy) {
      await ensureGovernanceLoaded();
      escalationPolicy = normalizeContextEscalationPolicy(policy);
      await asyncAdapter.upsertContextEscalationPolicy?.(config.scope, policy);
      return cloneContextEscalationPolicy(escalationPolicy);
    },

    async requestContextExpansion(request, options) {
      await ensureGovernanceLoaded();
      const currentContract = resolveContextContractReference(options?.currentContract);
      return buildContextExpansionResolution(request, currentContract);
    },
  };

  return {
    namespace,
    internal: {
      ensureGovernanceLoaded,
      resolveContextContractReference,
      getManagedInvariants,
    },
  };
}
