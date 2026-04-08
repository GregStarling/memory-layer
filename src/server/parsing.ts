import { normalizeTemporalId } from '../contracts/temporal.js';
import type {
  ContextContract,
  ContextInvariant,
  ContextEscalationPolicy,
  ContextGovernanceSnapshot,
} from '../contracts/context-contract.js';
import {
  CONTEXT_ESCALATION_CHANGE_KINDS,
  CONTEXT_ESCALATION_RULE_DECISIONS,
} from '../contracts/context-contract.js';
import type { ActorRef, ContextViewPolicy } from '../contracts/coordination.js';
import { ACTOR_KINDS, CONTEXT_VIEW_POLICIES } from '../contracts/coordination.js';

export type ParseFailure = (message: string) => never;

interface NumberParseOptions {
  name: string;
  integer?: boolean;
  min?: number;
  max?: number;
}

function coerceNumber(
  value: unknown,
  options: NumberParseOptions,
  fail: ParseFailure,
): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isFinite(parsed)) {
    fail(`Invalid field: ${options.name}`);
  }
  if (options.integer && !Number.isInteger(parsed)) {
    fail(`Invalid field: ${options.name}`);
  }
  if (options.min != null && parsed < options.min) {
    fail(`Invalid field: ${options.name}`);
  }
  if (options.max != null && parsed > options.max) {
    fail(`Invalid field: ${options.name}`);
  }
  return parsed;
}

export function parseOptionalFiniteNumber(
  value: unknown,
  options: NumberParseOptions,
  fail: ParseFailure,
): number | undefined {
  return coerceNumber(value, options, fail);
}

export function parseOptionalFiniteInteger(
  value: unknown,
  options: NumberParseOptions,
  fail: ParseFailure,
): number | undefined {
  return coerceNumber(value, { ...options, integer: true }, fail);
}

export function parseOptionalTemporalIdValue(
  value: unknown,
  name: string,
  fail: ParseFailure,
): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  try {
    return normalizeTemporalId(value as string | number | bigint);
  } catch {
    fail(`Invalid field: ${name}`);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function requireString(value: unknown, name: string, fail: ParseFailure): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`Missing or invalid field: ${name}`);
  }
  return value;
}

export function optionalString(value: unknown, name: string, fail: ParseFailure): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`Invalid field: ${name}`);
  }
  return value;
}

export function requireStringArray(value: unknown, name: string, fail: ParseFailure): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
    fail(`Invalid field: ${name}`);
  }
  return value.map((item) => item.trim());
}

export function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  name: string,
  fail: ParseFailure,
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    fail(`Invalid field: ${name}`);
  }
  return value as T;
}

export function parseOptionalNonNegativeInteger(
  value: unknown,
  name: string,
  fail: ParseFailure,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    fail(`Invalid field: ${name} (must be a non-negative integer)`);
  }
  return value;
}

export function parseContextViewPolicy(
  value: unknown,
  name: string,
  fail: ParseFailure,
): ContextViewPolicy | undefined {
  if (value == null) return undefined;
  return requireEnum(value, CONTEXT_VIEW_POLICIES, name, fail);
}

export function parseContextContract(
  value: unknown,
  name: string,
  fail: ParseFailure,
): ContextContract | undefined {
  if (value == null) return undefined;
  if (!isRecord(value)) {
    fail(`Invalid field: ${name}`);
  }
  const scopeLevels = ['scope', 'workspace', 'system', 'tenant'] as const;
  return {
    name: optionalString(value.name, `${name}.name`, fail),
    view:
      typeof value.view === 'string'
        ? requireEnum(value.view, CONTEXT_VIEW_POLICIES, `${name}.view`, fail)
        : undefined,
    crossScopeLevel:
      typeof value.crossScopeLevel === 'string'
        ? requireEnum(value.crossScopeLevel, scopeLevels, `${name}.crossScopeLevel`, fail)
        : undefined,
    tokenBudget:
      value.tokenBudget == null
        ? undefined
        : parseOptionalFiniteInteger(value.tokenBudget, { name: `${name}.tokenBudget`, min: 0 }, fail) ?? undefined,
    maxKnowledgeItems:
      value.maxKnowledgeItems == null
        ? undefined
        : parseOptionalFiniteInteger(value.maxKnowledgeItems, { name: `${name}.maxKnowledgeItems`, min: 0 }, fail) ?? undefined,
    maxRecentSummaries:
      value.maxRecentSummaries == null
        ? undefined
        : parseOptionalFiniteInteger(value.maxRecentSummaries, { name: `${name}.maxRecentSummaries`, min: 0 }, fail) ?? undefined,
    knowledgeClasses:
      value.knowledgeClasses == null
        ? undefined
        : requireStringArray(value.knowledgeClasses, `${name}.knowledgeClasses`, fail) as ContextContract['knowledgeClasses'],
    minimumTrustScore:
      value.minimumTrustScore == null
        ? undefined
        : parseOptionalFiniteNumber(value.minimumTrustScore, { name: `${name}.minimumTrustScore` }, fail) ?? undefined,
    includeCoordinationState:
      value.includeCoordinationState == null
        ? undefined
        : Boolean(value.includeCoordinationState),
  };
}

export function parseContextInvariant(
  value: unknown,
  name: string,
  fail: ParseFailure,
): ContextInvariant {
  if (!isRecord(value)) {
    fail(`Invalid field: ${name}`);
  }
  const scopeLevels = ['scope', 'workspace', 'system', 'tenant'] as const;
  const severities = ['critical', 'important', 'advisory'] as const;
  return {
    id: requireString(value.id, `${name}.id`, fail),
    title: requireString(value.title, `${name}.title`, fail),
    instruction: requireString(value.instruction, `${name}.instruction`, fail),
    severity:
      value.severity == null
        ? undefined
        : requireEnum(value.severity, severities, `${name}.severity`, fail),
    scopeLevel:
      value.scopeLevel == null
        ? undefined
        : requireEnum(value.scopeLevel, scopeLevels, `${name}.scopeLevel`, fail),
  };
}

export function parseContextEscalationPolicy(
  value: unknown,
  name: string,
  fail: ParseFailure,
): ContextEscalationPolicy {
  if (!isRecord(value)) {
    fail(`Invalid field: ${name}`);
  }
  const scopeLevels = ['scope', 'workspace', 'system', 'tenant'] as const;
  return {
    defaultDecision:
      value.defaultDecision == null
        ? undefined
        : requireEnum(value.defaultDecision, CONTEXT_ESCALATION_RULE_DECISIONS, `${name}.defaultDecision`, fail),
    byChange:
      value.byChange == null
        ? undefined
        : (() => {
            if (!isRecord(value.byChange)) {
              fail(`Invalid field: ${name}.byChange`);
            }
            const parsed: NonNullable<ContextEscalationPolicy['byChange']> = {};
            for (const [key, decision] of Object.entries(value.byChange)) {
              const changeKind = requireEnum(
                key,
                CONTEXT_ESCALATION_CHANGE_KINDS,
                `${name}.byChange.${key}`,
                fail,
              );
              parsed[changeKind] = requireEnum(
                decision,
                CONTEXT_ESCALATION_RULE_DECISIONS,
                `${name}.byChange.${key}`,
                fail,
              );
            }
            return parsed;
          })(),
    maxView:
      value.maxView == null
        ? undefined
        : requireEnum(value.maxView, CONTEXT_VIEW_POLICIES, `${name}.maxView`, fail),
    maxScopeLevel:
      value.maxScopeLevel == null
        ? undefined
        : requireEnum(value.maxScopeLevel, scopeLevels, `${name}.maxScopeLevel`, fail),
    maxTokenBudget:
      value.maxTokenBudget == null
        ? undefined
        : parseOptionalFiniteInteger(value.maxTokenBudget, { name: `${name}.maxTokenBudget`, min: 0 }, fail) ?? undefined,
    minimumAllowedTrustScore:
      value.minimumAllowedTrustScore == null
        ? undefined
        : parseOptionalFiniteNumber(
            value.minimumAllowedTrustScore,
            { name: `${name}.minimumAllowedTrustScore` },
            fail,
          ) ?? undefined,
  };
}

export function serializeContextGovernance(
  snapshot: ContextGovernanceSnapshot,
): Record<string, unknown> {
  return {
    defaultContract: snapshot.defaultContract,
    contracts: snapshot.contracts,
    invariants: snapshot.invariants.map((invariant) => ({
      id: invariant.id,
      title: invariant.title,
      instruction: invariant.instruction,
      severity: invariant.severity,
      scopeLevel: invariant.scopeLevel,
    })),
    escalationPolicy: snapshot.escalationPolicy,
  };
}

export function parseActorRef(
  value: unknown,
  name: string,
  fail: ParseFailure,
): ActorRef | undefined {
  if (value == null) return undefined;
  if (!isRecord(value)) {
    fail(`Invalid field: ${name}`);
  }
  return {
    actor_kind: requireEnum(value.actor_kind, ACTOR_KINDS, `${name}.actor_kind`, fail),
    actor_id: requireString(value.actor_id, `${name}.actor_id`, fail),
    system_id: value.system_id == null ? null : requireString(value.system_id, `${name}.system_id`, fail),
    display_name:
      value.display_name == null ? null : requireString(value.display_name, `${name}.display_name`, fail),
    metadata: isRecord(value.metadata) ? value.metadata : null,
  };
}

export const MAX_LIST_LIMIT = 100;

export function parseLimit(value: unknown, fail: ParseFailure): number | undefined {
  if (value == null) return undefined;
  let num: number;
  if (typeof value === 'number') {
    num = value;
  } else if (typeof value === 'string') {
    num = Number(value.trim());
  } else {
    fail('Invalid field: limit');
    return; // unreachable but satisfies TS
  }
  if (!Number.isInteger(num)) {
    fail('Invalid field: limit');
  }
  if (num > MAX_LIST_LIMIT) {
    fail(`Invalid field: limit (maximum ${MAX_LIST_LIMIT})`);
  }
  return num;
}

export function createParsers(fail: ParseFailure) {
  return {
    requireString: (v: unknown, n: string) => requireString(v, n, fail),
    optionalString: (v: unknown, n: string) => optionalString(v, n, fail),
    requireStringArray: (v: unknown, n: string) => requireStringArray(v, n, fail),
    requireEnum: <T extends string>(v: unknown, a: readonly T[], n: string) =>
      requireEnum(v, a, n, fail),
    parseOptionalNonNegativeInteger: (v: unknown, n: string) =>
      parseOptionalNonNegativeInteger(v, n, fail),
    parseContextViewPolicy: (v: unknown, n = 'view') =>
      parseContextViewPolicy(v, n, fail),
    parseContextContract: (v: unknown, n = 'contract') =>
      parseContextContract(v, n, fail),
    parseContextInvariant: (v: unknown, n = 'invariant') =>
      parseContextInvariant(v, n, fail),
    parseContextEscalationPolicy: (v: unknown, n = 'policy') =>
      parseContextEscalationPolicy(v, n, fail),
    parseActorRef: (v: unknown, n = 'actor') => parseActorRef(v, n, fail),
    parseLimit: (v: unknown) => parseLimit(v, fail),
  };
}
