import type { KnowledgeMemory, Playbook, WorkItem, WorkingMemory } from '../contracts/types.js';
import type { ContextInvariant } from '../contracts/context-contract.js';
import type { Profile, ProfileSection } from '../contracts/profile.js';
import type { MemoryContext } from './context.js';

export interface SessionBootstrap {
  currentObjective: string | null;
  sessionState: MemoryContext['sessionState'];
  workingMemory: WorkingMemory | null;
  relevantKnowledge: KnowledgeMemory[];
  recentSummaries: WorkingMemory[];
  activeObjectives: WorkItem[];
  unresolvedWork: string[];
  coordinationState?: MemoryContext['coordinationState'] | null;
  invariants?: ContextInvariant[];
  warnings?: MemoryContext['warnings'];
  degradedContext?: MemoryContext['degradedContext'];
  profile?: Profile | null;
}

export interface FormatOptions {
  includeCitations?: boolean;
  includeTrustMetadata?: boolean;
  includeProvisionalKnowledge?: boolean;
  includeDisputedKnowledge?: boolean;
  includeEvidenceMarkers?: boolean;
  headingLevel?: 'markdown' | 'plain';
}

function formatHeading(label: string, options?: FormatOptions): string {
  return options?.headingLevel === 'markdown' ? `## ${label}` : `${label}:`;
}

function formatTemporalQualifier(knowledge: KnowledgeMemory): string | null {
  const from = knowledge.valid_from;
  const until = knowledge.valid_until;
  if (from == null && until == null) return null;

  const formatDate = (epoch: number): string => new Date(epoch * 1000).toISOString().slice(0, 10);

  if (from != null && until != null) {
    return `Valid ${formatDate(from)} – ${formatDate(until)}`;
  }
  if (from != null) {
    return `In effect starting ${formatDate(from)}`;
  }
  return `Valid until ${formatDate(until!)}`;
}

function formatKnowledgeLine(knowledge: KnowledgeMemory, options?: FormatOptions): string {
  const suffix: string[] = [];
  if (options?.includeTrustMetadata) {
    suffix.push(
      `confidence=${knowledge.confidence}`,
      `score=${knowledge.confidence_score.toFixed(2)}`,
      `status=${knowledge.verification_status}`,
      `state=${knowledge.knowledge_state}`,
      `trust=${knowledge.trust_score.toFixed(2)}`,
    );
  }
  if (options?.includeEvidenceMarkers && knowledge.evidence_count > 0) {
    suffix.push(`evidence=${knowledge.evidence_count}`);
  }
  if (options?.includeCitations) {
    suffix.push(`memory:${knowledge.id}`);
  }
  const temporal = formatTemporalQualifier(knowledge);
  if (temporal) {
    suffix.push(temporal);
  }
  return suffix.length > 0 ? `- ${knowledge.fact} [${suffix.join(', ')}]` : `- ${knowledge.fact}`;
}

function formatInvariantLine(invariant: ContextInvariant): string {
  const meta = [invariant.severity ?? 'important', invariant.scopeLevel ?? 'scope'].join(', ');
  return `- ${invariant.title}: ${invariant.instruction} [${meta}]`;
}

function formatWarningLine(warning: NonNullable<MemoryContext['warnings']>[number]): string {
  return `- (${warning.severity}) ${warning.message}`;
}

export function formatContextForPrompt(
  context: MemoryContext,
  options?: FormatOptions,
): string {
  const sections = [
    formatHeading('Mode', options),
    context.mode,
    '',
    formatHeading('Current Objective', options),
    context.currentObjective ?? 'None',
    '',
    formatHeading('Session State', options),
    `Objective: ${context.sessionState.currentObjective ?? 'None'}`,
    `Blockers: ${
      context.sessionState.blockers.length > 0
        ? context.sessionState.blockers.join(' | ')
        : 'None'
    }`,
    `Assumptions: ${
      context.sessionState.assumptions.length > 0
        ? context.sessionState.assumptions.join(' | ')
        : 'None'
    }`,
    `Pending Decisions: ${
      context.sessionState.pendingDecisions.length > 0
        ? context.sessionState.pendingDecisions.join(' | ')
        : 'None'
    }`,
    `Active Tools: ${
      context.sessionState.activeTools.length > 0
        ? context.sessionState.activeTools.join(' | ')
        : 'None'
    }`,
    `Recent Outputs: ${
      context.sessionState.recentOutputs.length > 0
        ? context.sessionState.recentOutputs.join(' | ')
        : 'None'
    }`,
    ...(context.invariants?.length
      ? [
          '',
          formatHeading('Safety Invariants', options),
          ...context.invariants.map((invariant) => formatInvariantLine(invariant)),
        ]
      : []),
    ...(context.warnings?.length
      ? [
          '',
          formatHeading('Context Warnings', options),
          ...context.warnings.map((warning) => formatWarningLine(warning)),
        ]
      : []),
    '',
    formatHeading('Active State', options),
    ...(context.activeState.length > 0 ? context.activeState.map((item) => `- ${item}`) : ['- None']),
    '',
    formatHeading('Active Objectives', options),
    ...(context.activeObjectives.length > 0
      ? context.activeObjectives.map((item) => `- ${item.title} (${item.status})`)
      : ['- None']),
    '',
    formatHeading('Trusted Core Memory', options),
    ...(context.trustedCoreMemory.length > 0
      ? context.trustedCoreMemory.map((item) => formatKnowledgeLine(item, options))
      : ['- None']),
    '',
    formatHeading('Task Relevant Knowledge', options),
    ...(context.taskRelevantKnowledge.length > 0
      ? context.taskRelevantKnowledge.map((item) => formatKnowledgeLine(item, options))
      : ['- None']),
    '',
    formatHeading('Unresolved Work', options),
    ...(context.unresolvedWork.length > 0
      ? context.unresolvedWork.map((item) => `- ${item}`)
      : ['- None']),
    '',
    formatHeading('Recent Summaries', options),
    ...(context.recentSummaries.length > 0
      ? context.recentSummaries.map((item) => `- ${item.summary}`)
      : ['- None']),
  ];

  sections.push(
    '',
    formatHeading('Relevant Playbooks', options),
    ...(context.relevantPlaybooks?.length
      ? context.relevantPlaybooks.flatMap((pb) => [
          `- ${pb.title} (${pb.status})${pb.description ? `: ${pb.description}` : ''}`,
          ...(pb.instructions ? [`  Instructions: ${pb.instructions}`] : []),
          ...(pb.references?.length ? [`  References: ${pb.references.join(', ')}`] : []),
          ...(pb.scripts?.length ? [`  Scripts: ${pb.scripts.join(', ')}`] : []),
        ])
      : ['- None']),
  );

  if (context.associatedKnowledge?.length) {
    sections.push(
      '',
      formatHeading('Related Knowledge (via associations)', options),
      ...context.associatedKnowledge.map((k) => {
        const temporal = formatTemporalQualifier(k);
        const suffix = temporal ? ` [${temporal}]` : '';
        return `- [${k.knowledge_class}] ${k.fact} (trust: ${k.trust_score.toFixed(2)})${suffix}`;
      }),
    );
  }

  if (context.coordinationState) {
    sections.push(
      '',
      formatHeading('Coordination State', options),
      `Currently Owned Work: ${
        context.coordinationState.ownedClaims.length > 0
          ? context.coordinationState.ownedClaims.map((claim) => `#${claim.work_item_id}`).join(' | ')
          : 'None'
      }`,
      `Handoffs To Review: ${
        context.coordinationState.pendingInboundHandoffs.length > 0
          ? context.coordinationState.pendingInboundHandoffs.map((handoff) => handoff.summary).join(' | ')
          : 'None'
      }`,
      `Work Awaiting Pickup: ${
        context.coordinationState.pendingOutboundHandoffs.length > 0
          ? context.coordinationState.pendingOutboundHandoffs.map((handoff) => handoff.summary).join(' | ')
          : 'None'
      }`,
    );
  }

  if (options?.includeProvisionalKnowledge) {
    sections.push(
      '',
      formatHeading('Provisional Knowledge', options),
      ...(context.provisionalKnowledge.length > 0
        ? context.provisionalKnowledge.map((item) => formatKnowledgeLine(item, options))
        : ['- None']),
    );
  }

  if (options?.includeDisputedKnowledge) {
    sections.push(
      '',
      formatHeading('Disputed Knowledge', options),
      ...(context.disputedKnowledge.length > 0
        ? context.disputedKnowledge.map((item) => formatKnowledgeLine(item, options))
        : ['- None']),
    );
  }

  return sections.join('\n');
}

export function formatBootstrapForPrompt(
  bootstrap: SessionBootstrap,
  options?: FormatOptions,
): string {
  return [
    formatHeading('Bootstrap Objective', options),
    bootstrap.currentObjective ?? 'None',
    '',
    formatHeading('Bootstrap Session State', options),
    `Objective: ${bootstrap.sessionState.currentObjective ?? 'None'}`,
    `Blockers: ${
      bootstrap.sessionState.blockers.length > 0
        ? bootstrap.sessionState.blockers.join(' | ')
        : 'None'
    }`,
    `Assumptions: ${
      bootstrap.sessionState.assumptions.length > 0
        ? bootstrap.sessionState.assumptions.join(' | ')
        : 'None'
    }`,
    `Pending Decisions: ${
      bootstrap.sessionState.pendingDecisions.length > 0
        ? bootstrap.sessionState.pendingDecisions.join(' | ')
        : 'None'
    }`,
    `Active Tools: ${
      bootstrap.sessionState.activeTools.length > 0
        ? bootstrap.sessionState.activeTools.join(' | ')
        : 'None'
    }`,
    `Recent Outputs: ${
      bootstrap.sessionState.recentOutputs.length > 0
        ? bootstrap.sessionState.recentOutputs.join(' | ')
        : 'None'
    }`,
    ...(bootstrap.invariants?.length
      ? [
          '',
          formatHeading('Bootstrap Invariants', options),
          ...bootstrap.invariants.map((invariant) => formatInvariantLine(invariant)),
        ]
      : []),
    ...(bootstrap.warnings?.length
      ? [
          '',
          formatHeading('Bootstrap Warnings', options),
          ...bootstrap.warnings.map((warning) => formatWarningLine(warning)),
        ]
      : []),
    '',
    formatHeading('Bootstrap Working Memory', options),
    bootstrap.workingMemory?.summary ?? 'None',
    '',
    formatHeading('Bootstrap Objectives', options),
    ...(bootstrap.activeObjectives.length > 0
      ? bootstrap.activeObjectives.map((item) => `- ${item.title} (${item.status})`)
      : ['- None']),
    '',
    formatHeading('Bootstrap Knowledge', options),
    ...(bootstrap.relevantKnowledge.length > 0
      ? bootstrap.relevantKnowledge.map((item) => formatKnowledgeLine(item, options))
      : ['- None']),
    '',
    formatHeading('Bootstrap Unresolved Work', options),
    ...(bootstrap.unresolvedWork.length > 0
      ? bootstrap.unresolvedWork.map((item) => `- ${item}`)
      : ['- None']),
    '',
    formatHeading('Bootstrap Coordination', options),
    ...(bootstrap.coordinationState
      ? [
          `Owned Claims: ${
            bootstrap.coordinationState.ownedClaims.length > 0
              ? bootstrap.coordinationState.ownedClaims.map((claim) => `#${claim.work_item_id}`).join(' | ')
              : 'None'
          }`,
          `Inbound Handoffs: ${
            bootstrap.coordinationState.pendingInboundHandoffs.length > 0
              ? bootstrap.coordinationState.pendingInboundHandoffs.map((handoff) => handoff.summary).join(' | ')
              : 'None'
          }`,
          `Outbound Handoffs: ${
            bootstrap.coordinationState.pendingOutboundHandoffs.length > 0
              ? bootstrap.coordinationState.pendingOutboundHandoffs.map((handoff) => handoff.summary).join(' | ')
              : 'None'
          }`,
        ]
      : ['None']),
    ...formatProfileSection(bootstrap.profile, options),
  ].join('\n');
}

function formatProfileSection(
  profile: Profile | null | undefined,
  options?: FormatOptions,
): string[] {
  if (!profile) return [];

  const sectionLabels: Record<ProfileSection, string> = {
    identity: 'Identity',
    preferences: 'Preferences',
    communication: 'Communication',
    constraints: 'Constraints',
    workflows: 'Workflows',
  };

  const lines: string[] = ['', formatHeading('Profile', options)];

  const sections: ProfileSection[] = ['identity', 'preferences', 'communication', 'constraints', 'workflows'];
  let hasContent = false;

  for (const section of sections) {
    const entries = profile.sections[section];
    if (entries.length === 0) continue;
    hasContent = true;
    lines.push(`  ${sectionLabels[section]}:`);
    for (const entry of entries) {
      const suffix = options?.includeTrustMetadata
        ? ` [trust=${entry.trustScore.toFixed(2)}, state=${entry.knowledgeState}]`
        : '';
      lines.push(`  - ${entry.fact}${suffix}`);
    }
  }

  if (!hasContent) {
    lines.push('- None');
  }

  return lines;
}

export function formatContextAsMessages(
  context: MemoryContext,
  options?: FormatOptions,
): Array<{ role: 'system'; content: string }> {
  return [
    {
      role: 'system',
      content: formatContextForPrompt(context, options),
    },
  ];
}
