import type { KnowledgeMemory, WorkItem, WorkingMemory } from '../contracts/types.js';
import type { MemoryContext } from './context.js';

export interface SessionBootstrap {
  currentObjective: string | null;
  workingMemory: WorkingMemory | null;
  relevantKnowledge: KnowledgeMemory[];
  recentSummaries: WorkingMemory[];
  activeObjectives: WorkItem[];
  unresolvedWork: string[];
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
  return suffix.length > 0 ? `- ${knowledge.fact} [${suffix.join(', ')}]` : `- ${knowledge.fact}`;
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
  ].join('\n');
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
