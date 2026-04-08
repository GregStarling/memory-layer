import {
  createMemoryWithAsyncAdapter,
  type CreateMemoryOptions,
} from '../core/quick.js';
import type { MemoryManager } from '../core/manager.js';
import type { MemoryContext } from '../core/context.js';
import { createMemoryRuntime, type MemoryRuntime } from '../core/runtime.js';
import type {
  ActorRef,
  HandoffRecord,
  WorkClaim,
} from '../contracts/coordination.js';
import { normalizeScope, type MemoryScope, type ScopeLevel } from '../contracts/identity.js';
import type { AsyncStorageAdapter } from '../contracts/async-storage.js';
import type { EmbeddingAdapter } from '../contracts/embedding.js';
import { isMemoryDomainError } from '../contracts/errors.js';
import type { TemporalStateSnapshot, TimelineResult } from '../contracts/temporal.js';
import type { FactType, FactConfidence, EpisodeDetailLevel, AssociationTargetKind, AssociationType } from '../contracts/types.js';
import { ASSOCIATION_TARGET_KINDS, ASSOCIATION_TYPES } from '../contracts/types.js';
import { ACTOR_KINDS, CONTEXT_VIEW_POLICIES, MEMORY_VISIBILITY_CLASSES } from '../contracts/coordination.js';
import type { ProfileView, ProfileSection } from '../contracts/profile.js';
import type { CognitiveMemoryType } from '../contracts/cognitive.js';
import { createSQLiteAdapterWithEmbeddings } from '../adapters/sqlite/index.js';
import { wrapSyncAdapter } from '../adapters/sync-to-async.js';
import {
  parseOptionalFiniteInteger,
  parseOptionalFiniteNumber,
  parseOptionalTemporalIdValue,
} from './parsing.js';

export interface McpServerConfig {
  /** Database path. Defaults to ':memory:'. */
  dbPath?: string;
  /** Default scope for all operations. Can be overridden per-tool-call. */
  scope?: string | MemoryScope;
  /** Summarizer: 'extractive' | 'claude' | 'openai'. Defaults to 'extractive'. */
  summarizer?: CreateMemoryOptions['summarizer'];
  /** Extractor: 'regex' | 'claude' | 'openai' | false. Defaults to 'regex'. */
  extractor?: CreateMemoryOptions['extractor'];
  /** Preset: 'ai_ide' | 'chat_agent' | 'autonomous_agent'. */
  preset?: CreateMemoryOptions['preset'];
  /** Optional Postgres connection string for hosted deployments. */
  databaseUrl?: string;
  /** Quality mode applied to hosted managers. */
  qualityMode?: CreateMemoryOptions['qualityMode'];
  /** Legacy quality tier mapping. */
  qualityTier?: CreateMemoryOptions['qualityTier'];
  /** Cross-scope retrieval level for hosted managers. */
  crossScopeLevel?: ScopeLevel;
  /** Auto-detect workspace from git remote or cwd when no scope provided. */
  autoDetectWorkspace?: boolean;
  /** Structured generation client for episodic recall, playbooks, and reflect. */
  structuredClient?: CreateMemoryOptions['structuredClient'];
  /** Default event cap for diff/reporting tools. Defaults to 5000. */
  defaultDiffMaxEvents?: number;
  /** Hard maximum event cap for diff/reporting tools. Defaults to 20000. */
  maxDiffMaxEvents?: number;
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

class McpValidationError extends Error {}

const MAX_LIST_LIMIT = 100;
const MANAGER_CACHE_LIMIT = 256;
const SESSION_MANAGER_CACHE_LIMIT = 256;
const RUNTIME_CACHE_LIMIT = 256;
const DEFAULT_DIFF_MAX_EVENTS = 5000;
const MAX_DIFF_MAX_EVENTS = 20000;
const TEMPORAL_ENTITY_KINDS = [
  'turn',
  'working_memory',
  'knowledge_memory',
  'work_item',
  'association',
  'playbook',
  'playbook_revision',
  'session_state',
  'work_claim',
  'handoff',
] as const;

function failMcpValidation(message: string): never {
  throw new McpValidationError(message);
}

function resolveDiffEventCaps(
  defaultMaxEvents?: number,
  maxMaxEvents?: number,
): { defaultDiffMaxEvents: number; maxDiffMaxEvents: number } {
  const resolvedMax = maxMaxEvents ?? MAX_DIFF_MAX_EVENTS;
  const resolvedDefault = defaultMaxEvents ?? DEFAULT_DIFF_MAX_EVENTS;
  if (!Number.isInteger(resolvedMax) || resolvedMax < 1) {
    throw new Error('memory-layer: maxDiffMaxEvents must be a positive integer');
  }
  if (!Number.isInteger(resolvedDefault) || resolvedDefault < 1) {
    throw new Error('memory-layer: defaultDiffMaxEvents must be a positive integer');
  }
  if (resolvedDefault > resolvedMax) {
    throw new Error('memory-layer: defaultDiffMaxEvents must not exceed maxDiffMaxEvents');
  }
  return {
    defaultDiffMaxEvents: resolvedDefault,
    maxDiffMaxEvents: resolvedMax,
  };
}

const TOOLS: McpTool[] = [
  {
    name: 'memory_store_turn',
    description: 'Store a single conversation turn in memory.',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', enum: ['user', 'assistant', 'system'], description: 'Turn role' },
        content: { type: 'string', description: 'Turn content' },
        actor: { type: 'string', description: 'Optional actor name' },
      },
      required: ['role', 'content'],
    },
  },
  {
    name: 'memory_store_exchange',
    description: 'Store a user+assistant exchange atomically.',
    inputSchema: {
      type: 'object',
      properties: {
        userContent: { type: 'string', description: 'User message content' },
        assistantContent: { type: 'string', description: 'Assistant response content' },
      },
      required: ['userContent', 'assistantContent'],
    },
  },
  {
    name: 'memory_get_context',
    description: 'Retrieve assembled memory context for prompt injection. Returns active turns, working memory, relevant knowledge, objectives, and unresolved work.',
    inputSchema: {
      type: 'object',
      properties: {
        relevanceQuery: { type: 'string', description: 'Optional query to rank knowledge by relevance' },
        view: {
          type: 'string',
          enum: ['local_only', 'local_plus_shared_collaboration', 'operator_supervisor', 'workspace_shared'],
          description: 'Optional context visibility/view policy',
        },
        viewer: { type: 'object', description: 'Optional viewer actor for operator/supervisor coordination views' },
        includeCoordinationState: { type: 'boolean', description: 'Include coordination state in the response' },
        includeDebug: { type: 'boolean', description: 'Include selection reasons and debug trace' },
      },
    },
  },
  {
    name: 'memory_get_state_at',
    description: 'Get exact temporal state and assembled context at a specific unix timestamp.',
    inputSchema: {
      type: 'object',
      properties: {
        asOf: { type: 'number', description: 'Unix timestamp to replay at' },
        relevanceQuery: { type: 'string', description: 'Optional query to rank knowledge' },
        view: {
          type: 'string',
          enum: ['local_only', 'local_plus_shared_collaboration', 'operator_supervisor', 'workspace_shared'],
          description: 'Optional context visibility/view policy',
        },
        viewer: { type: 'object', description: 'Optional viewer actor for operator/supervisor coordination views' },
        includeCoordinationState: { type: 'boolean', description: 'Include coordination state in the response' },
        includeDebug: { type: 'boolean', description: 'Include debug traces in the context payload' },
      },
      required: ['asOf'],
    },
  },
  {
    name: 'memory_get_timeline',
    description: 'List memory events in chronological order.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Optional session filter' },
        entityKind: {
          type: 'string',
          enum: [...TEMPORAL_ENTITY_KINDS],
          description: 'Optional entity kind filter',
        },
        entityId: { type: 'string', description: 'Optional entity id filter' },
        startAt: { type: 'number', description: 'Optional start unix timestamp' },
        endAt: { type: 'number', description: 'Optional end unix timestamp' },
        limit: { type: 'number', description: 'Optional page size' },
        cursor: {
          anyOf: [{ type: 'number' }, { type: 'string' }],
          description: 'Optional event-id cursor',
        },
      },
    },
  },
  {
    name: 'memory_diff_state',
    description: 'Summarize memory events between two unix timestamps.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'number', description: 'Start unix timestamp (exclusive)' },
        to: { type: 'number', description: 'End unix timestamp (inclusive)' },
        sessionId: { type: 'string', description: 'Optional session filter' },
        entityKind: {
          type: 'string',
          enum: [...TEMPORAL_ENTITY_KINDS],
          description: 'Optional entity kind filter',
        },
        entityId: { type: 'string', description: 'Optional entity id filter' },
        maxEvents: {
          type: 'number',
          description:
            'Optional maximum event count to accumulate. Defaults to the server-configured diff cap and must not exceed the configured maximum.',
        },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'memory_list_events',
    description: 'List memory events in reverse chronological order for inspection.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Optional session filter' },
        entityKind: {
          type: 'string',
          enum: [...TEMPORAL_ENTITY_KINDS],
          description: 'Optional entity kind filter',
        },
        entityId: { type: 'string', description: 'Optional entity id filter' },
        startAt: { type: 'number', description: 'Optional start unix timestamp' },
        endAt: { type: 'number', description: 'Optional end unix timestamp' },
        limit: { type: 'number', description: 'Optional page size' },
        cursor: {
          anyOf: [{ type: 'number' }, { type: 'string' }],
          description: 'Optional event-id cursor',
        },
      },
    },
  },
  {
    name: 'memory_search',
    description: 'Search across turns and knowledge using hybrid lexical+semantic retrieval.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results (default: 10)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tag filter — only return knowledge matching these tags' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_search_cross_scope',
    description: 'Search durable knowledge across collaboration, system, or tenant boundaries.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        scopeLevel: {
          type: 'string',
          enum: ['workspace', 'system', 'tenant'],
          description: 'Cross-scope level (default: workspace)',
        },
        limit: { type: 'number', description: 'Max results (default: 10)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tag filter — only return knowledge matching these tags' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_learn_fact',
    description: 'Manually add a durable knowledge fact.',
    inputSchema: {
      type: 'object',
      properties: {
        fact: { type: 'string', description: 'The fact to store' },
        factType: {
          type: 'string',
          enum: ['preference', 'entity', 'decision', 'constraint', 'reference'],
          description: 'Fact classification',
        },
        confidence: {
          type: 'string',
          enum: ['high', 'medium', 'low'],
          description: 'Confidence level (default: high)',
        },
      },
      required: ['fact', 'factType'],
    },
  },
  {
    name: 'memory_track_work',
    description: 'Track an objective, unresolved work item, or constraint.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Work item title' },
        kind: { type: 'string', enum: ['objective', 'unresolved_work', 'constraint'], description: 'Item kind (default: objective)' },
        status: { type: 'string', enum: ['open', 'in_progress', 'blocked', 'done'], description: 'Item status (default: open)' },
        detail: { type: 'string', description: 'Additional detail' },
      },
      required: ['title'],
    },
  },
  {
    name: 'memory_update_work_item',
    description: 'Update an existing work item.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number' },
        title: { type: 'string' },
        detail: { type: 'string' },
        status: { type: 'string', enum: ['open', 'in_progress', 'blocked', 'done'] },
        visibility_class: { type: 'string', enum: ['private', 'shared_collaboration', 'workspace', 'tenant'] },
        expectedVersion: { type: 'number' },
      },
      required: ['id'],
    },
  },
  {
    name: 'memory_claim_work_item',
    description: 'Acquire or renew an exclusive claim on a work item.',
    inputSchema: {
      type: 'object',
      properties: {
        workItemId: { type: 'number' },
        actor: { type: 'object' },
        leaseSeconds: { type: 'number' },
      },
      required: ['workItemId', 'actor'],
    },
  },
  {
    name: 'memory_renew_work_claim',
    description: 'Renew an exclusive claim on a work item.',
    inputSchema: {
      type: 'object',
      properties: {
        claimId: { type: 'number' },
        actor: { type: 'object' },
        leaseSeconds: { type: 'number' },
      },
      required: ['claimId', 'actor'],
    },
  },
  {
    name: 'memory_release_work_claim',
    description: 'Release a claimed work item.',
    inputSchema: {
      type: 'object',
      properties: {
        claimId: { type: 'number' },
        actor: { type: 'object' },
        reason: { type: 'string' },
      },
      required: ['claimId', 'actor'],
    },
  },
  {
    name: 'memory_list_work_claims',
    description: 'List current work claims.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'memory_handoff_work_item',
    description: 'Create a handoff for a work item.',
    inputSchema: {
      type: 'object',
      properties: {
        workItemId: { type: 'number' },
        fromActor: { type: 'object' },
        toActor: { type: 'object' },
        summary: { type: 'string' },
        contextBundleRef: { type: 'string' },
        expiresAt: { type: 'number' },
      },
      required: ['workItemId', 'fromActor', 'toActor', 'summary'],
    },
  },
  {
    name: 'memory_accept_handoff',
    description: 'Accept a handoff.',
    inputSchema: {
      type: 'object',
      properties: {
        handoffId: { type: 'number' },
        actor: { type: 'object' },
        reason: { type: 'string' },
      },
      required: ['handoffId', 'actor'],
    },
  },
  {
    name: 'memory_reject_handoff',
    description: 'Reject a handoff.',
    inputSchema: {
      type: 'object',
      properties: {
        handoffId: { type: 'number' },
        actor: { type: 'object' },
        reason: { type: 'string' },
      },
      required: ['handoffId', 'actor'],
    },
  },
  {
    name: 'memory_cancel_handoff',
    description: 'Cancel a handoff.',
    inputSchema: {
      type: 'object',
      properties: {
        handoffId: { type: 'number' },
        actor: { type: 'object' },
        reason: { type: 'string' },
      },
      required: ['handoffId', 'actor'],
    },
  },
  {
    name: 'memory_list_pending_handoffs',
    description: 'List pending handoffs.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['inbound', 'outbound', 'all'] },
      },
    },
  },
  {
    name: 'memory_stream_changes',
    description: 'List durable change events after an optional cursor.',
    inputSchema: {
      type: 'object',
      properties: {
        cursor: { anyOf: [{ type: 'number' }, { type: 'string' }] },
        sessionId: { type: 'string' },
        entityKind: { type: 'string', enum: [...TEMPORAL_ENTITY_KINDS] },
        entityId: { type: 'string' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'memory_force_compact',
    description: 'Force compaction of conversation history into a summary.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'memory_get_health',
    description: 'Get memory health report including compaction state and token estimates.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'memory_run_maintenance',
    description: 'Run maintenance to expire stale data, retire unused knowledge, and clean up completed work items.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'memory_search_episodes',
    description: 'Search episodic memory for past sessions matching a query. Returns structured recaps with objectives, actions, outcomes, and unresolved items.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        detailLevel: {
          type: 'string',
          enum: ['abstract', 'overview', 'full'],
          description: 'Detail level for results (default: overview)',
        },
        limit: { type: 'number', description: 'Max results (default: 10)' },
        timeRange: {
          type: 'object',
          properties: {
            start_at: { type: 'number', description: 'Unix timestamp lower bound' },
            end_at: { type: 'number', description: 'Unix timestamp upper bound' },
          },
          description: 'Optional time range filter',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_summarize_episode',
    description: 'Summarize a specific session into a structured episodic recap.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session ID to summarize' },
        detailLevel: {
          type: 'string',
          enum: ['abstract', 'overview', 'full'],
          description: 'Detail level (default: overview)',
        },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'memory_reflect',
    description: 'Synthesize an answer from episodic and declarative memory. Returns a coherent synthesis with source attribution.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Reflection query' },
        detailLevel: {
          type: 'string',
          enum: ['abstract', 'overview', 'full'],
          description: 'Detail level (default: overview)',
        },
        includeEpisodic: { type: 'boolean', description: 'Include episodic memory (default: true)' },
        includeDeclarative: { type: 'boolean', description: 'Include declarative memory (default: true)' },
        limit: { type: 'number', description: 'Max sources (default: 10)' },
        timeRange: {
          type: 'object',
          properties: {
            start_at: { type: 'number', description: 'Unix timestamp lower bound' },
            end_at: { type: 'number', description: 'Unix timestamp upper bound' },
          },
          description: 'Optional time range filter',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_search_cognitive',
    description: 'Search memory using the cognitive taxonomy (episodic, semantic, procedural, working). Returns results grouped by cognitive type.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        types: {
          type: 'array',
          items: { type: 'string', enum: ['episodic', 'semantic', 'procedural', 'working'] },
          description: 'Cognitive memory types to search (default: all)',
        },
        limit: { type: 'number', description: 'Max results (default: 10)' },
        minimumTrustScore: { type: 'number', description: 'Minimum trust score filter' },
        activeOnly: { type: 'boolean', description: 'Only return active memories (default: true)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_get_profile',
    description: 'Get a materialized profile view built from trusted knowledge. Returns identity, preferences, communication, constraints, and workflows.',
    inputSchema: {
      type: 'object',
      properties: {
        view: {
          type: 'string',
          enum: ['user', 'operator', 'workspace'],
          description: 'Profile view type (default: user)',
        },
        sections: {
          type: 'array',
          items: { type: 'string', enum: ['identity', 'preferences', 'communication', 'constraints', 'workflows'] },
          description: 'Specific sections to include (default: all)',
        },
        minimumTrustScore: { type: 'number', description: 'Minimum trust score filter' },
        includeProvisional: { type: 'boolean', description: 'Include provisional knowledge entries (default: false — profiles are trusted-only)' },
        includeDisputed: { type: 'boolean', description: 'Include disputed knowledge entries (default: false)' },
      },
    },
  },
  {
    name: 'memory_create_playbook',
    description: 'Create a reusable playbook from a title, description, and instructions.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Playbook title' },
        description: { type: 'string', description: 'What this playbook is for' },
        instructions: { type: 'string', description: 'Step-by-step instructions' },
        references: { type: 'array', items: { type: 'string' }, description: 'Referenced files, URLs, or tools' },
        templates: { type: 'array', items: { type: 'string' }, description: 'Reusable templates or patterns' },
        scripts: { type: 'array', items: { type: 'string' }, description: 'Commands or scripts' },
        assets: { type: 'array', items: { type: 'string' }, description: 'Associated assets' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags for categorization',
        },
        status: {
          type: 'string',
          enum: ['draft', 'active', 'deprecated', 'archived'],
          description: 'Playbook status (default: draft)',
        },
      },
      required: ['title', 'description', 'instructions'],
    },
  },
  {
    name: 'memory_search_playbooks',
    description: 'Search for relevant playbooks by query. Returns ranked results.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results (default: 20)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_revise_playbook',
    description: 'Revise a playbook by storing the current instructions as a revision and updating with new instructions.',
    inputSchema: {
      type: 'object',
      properties: {
        playbookId: { type: 'number', description: 'ID of the playbook to revise' },
        newInstructions: { type: 'string', description: 'Updated instructions' },
        revisionReason: { type: 'string', description: 'Why the playbook is being revised' },
        sourceSessionId: { type: 'string', description: 'Optional session ID that triggered the revision' },
      },
      required: ['playbookId', 'newInstructions', 'revisionReason'],
    },
  },
  {
    name: 'memory_create_playbook_from_task',
    description: 'Create a playbook by summarizing the turns of a completed task session into structured instructions.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Playbook title' },
        description: { type: 'string', description: 'What this playbook is for' },
        sessionId: { type: 'string', description: 'Session to derive the playbook from' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags' },
        sourceWorkingMemoryId: {
          type: 'number',
          description: 'Optional working memory id that anchors the source task',
        },
      },
      required: ['title', 'description', 'sessionId'],
    },
  },
  {
    name: 'memory_use_playbook',
    description: 'Record that a playbook was used and return the full playbook record.',
    inputSchema: {
      type: 'object',
      properties: {
        playbookId: { type: 'number', description: 'ID of the playbook that was used' },
      },
      required: ['playbookId'],
    },
  },
  {
    name: 'memory_get_associations',
    description: 'Get or traverse associations for a memory artifact. Use traverse mode for multi-hop graph expansion.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['knowledge', 'playbook', 'working_memory', 'work_item'], description: 'Type of the source artifact' },
        id: { type: 'number', description: 'ID of the source artifact' },
        traverse: { type: 'boolean', description: 'If true, perform BFS traversal instead of direct lookup' },
        maxDepth: { type: 'number', description: 'Max traversal depth (default 2, only used with traverse)' },
        maxNodes: { type: 'number', description: 'Max nodes to return (default 20, only used with traverse)' },
      },
      required: ['kind', 'id'],
    },
  },
  {
    name: 'memory_add_association',
    description: 'Create an association between two memory artifacts.',
    inputSchema: {
      type: 'object',
      properties: {
        source_kind: { type: 'string', enum: ['knowledge', 'playbook', 'working_memory', 'work_item'] },
        source_id: { type: 'number' },
        target_kind: { type: 'string', enum: ['knowledge', 'playbook', 'working_memory', 'work_item'] },
        target_id: { type: 'number' },
        association_type: { type: 'string', enum: ['related_to', 'supports', 'contradicts', 'supersedes', 'depends_on', 'solves', 'applies_to', 'derived_from'] },
        confidence: { type: 'number', description: 'Confidence score 0-1 (default 0.5)' },
      },
      required: ['source_kind', 'source_id', 'target_kind', 'target_id', 'association_type'],
    },
  },
  {
    name: 'memory_remove_association',
    description: 'Delete an association by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Association ID to delete' },
      },
      required: ['id'],
    },
  },
  {
    name: 'memory_snapshot',
    description: 'Manage session snapshots for cache-stable prompt injection. Actions: capture (freeze current state), refresh (recapture), get (return cached snapshot or null).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['capture', 'refresh', 'get'],
          description: 'Snapshot action to perform',
        },
        sessionId: {
          type: 'string',
          description: 'Session ID the snapshot belongs to',
        },
        relevanceQuery: {
          type: 'string',
          description: 'Optional query to rank knowledge during capture/refresh',
        },
      },
      required: ['action', 'sessionId'],
    },
  },
  // --- Phase 5 tools ---
  {
    name: 'memory_discover',
    description: 'Discover surprising connections and high-centrality entities in the knowledge graph.',
    inputSchema: {
      type: 'object',
      properties: {
        maxResults: { type: 'number', description: 'Maximum surprise results to return (default: 10)' },
        minSurpriseScore: { type: 'number', description: 'Minimum surprise score threshold 0-1' },
        maxDepth: { type: 'number', description: 'Maximum graph traversal depth' },
      },
    },
  },
  {
    name: 'memory_get_report',
    description: 'Generate a structured graph report of the knowledge base with token budget control.',
    inputSchema: {
      type: 'object',
      properties: {
        tokenBudget: { type: 'number', description: 'Token budget for the report' },
        includeSections: { type: 'array', items: { type: 'string' }, description: 'Sections to include' },
        filterByTags: { type: 'array', items: { type: 'string' }, description: 'Filter knowledge by tags' },
      },
    },
  },
  {
    name: 'memory_get_facts_at',
    description: 'Get knowledge facts valid at a specific timestamp using fast temporal filtering with validity window fallback.',
    inputSchema: {
      type: 'object',
      properties: {
        timestamp: { type: 'number', description: 'Unix timestamp (epoch seconds) to query facts at' },
      },
      required: ['timestamp'],
    },
  },
  {
    name: 'memory_reflect_knowledge',
    description: 'Run the knowledge reflection engine to discover new facts, recurring patterns, and alias candidates from existing knowledge.',
    inputSchema: {
      type: 'object',
      properties: {
        maxFacts: { type: 'number', description: 'Maximum new facts to produce (default: 10)' },
        includePlaybooks: { type: 'boolean', description: 'Include playbook-derived patterns (default: true)' },
        rateLimitKey: { type: 'string', description: 'Key for rate-limiting reflection calls' },
      },
    },
  },
  {
    name: 'memory_derive',
    description: 'Produce typed draft outputs (playbook candidates, coding rules, anti-patterns, project summaries) from reflection results and active knowledge.',
    inputSchema: {
      type: 'object',
      properties: {
        outputTypes: {
          type: 'array',
          items: { type: 'string', enum: ['playbook_candidate', 'coding_rule', 'anti_pattern', 'project_summary'] },
          description: 'Output types to produce (default: all)',
        },
        maxOutputs: { type: 'number', description: 'Maximum outputs to return (default: 20)' },
      },
    },
  },
  {
    name: 'memory_get_curation',
    description: 'Get a structured curation summary aggregating recent actions from maintenance, reflection, ontology, and derived pipelines.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'number', description: 'Only include actions after this timestamp (epoch seconds)' },
        actionTypes: {
          type: 'array',
          items: { type: 'string', enum: ['retired', 'expired', 'demoted', 'reflected', 'merged', 'derived', 'reverified'] },
          description: 'Filter by action types',
        },
        limit: { type: 'number', description: 'Maximum actions to return (default: 100)' },
      },
    },
  },
  {
    name: 'memory_get_core_memory',
    description: 'Retrieve the core memory bundle: identity facts, constraints, norms, active work items, and top playbook.',
    inputSchema: {
      type: 'object',
      properties: {
        tokenBudget: { type: 'number', description: 'Maximum token budget (default: 1500)' },
        includeClasses: {
          type: 'array',
          items: { type: 'string' },
          description: 'Restrict to specific knowledge classes',
        },
      },
    },
  },
  {
    name: 'memory_set_aliases',
    description: 'Set the alias map for entity name canonicalization during extraction.',
    inputSchema: {
      type: 'object',
      properties: {
        aliases: {
          type: 'object',
          description: 'Alias map: { canonical_name: [alias1, alias2, ...] }',
          additionalProperties: { type: 'array', items: { type: 'string' } },
        },
      },
      required: ['aliases'],
    },
  },
  {
    name: 'memory_get_aliases',
    description: 'Get the current alias map configuration.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'memory_get_alias_candidates',
    description: 'Discover potential alias pairs from entity name similarity in the knowledge base.',
    inputSchema: {
      type: 'object',
      properties: {
        threshold: { type: 'number', description: 'Minimum similarity score 0-1 (default: 0.85)' },
        maxCandidates: { type: 'number', description: 'Maximum candidates to return (default: 20)' },
      },
    },
  },
  {
    name: 'memory_set_ontology',
    description: 'Set the ontology configuration with entity type definitions, relationship constraints, and validation rules.',
    inputSchema: {
      type: 'object',
      properties: {
        entityTypes: { type: 'array', items: { type: 'object' }, description: 'Entity type definitions' },
        relationshipConstraints: { type: 'array', items: { type: 'object' }, description: 'Relationship constraints' },
        validationRules: { type: 'array', items: { type: 'object' }, description: 'Validation rules' },
      },
      required: ['entityTypes', 'relationshipConstraints', 'validationRules'],
    },
  },
  {
    name: 'memory_get_ontology',
    description: 'Get the current ontology configuration.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'memory_export_bundle',
    description: 'Export knowledge and playbooks as a portable bundle.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Bundle name' },
        includeTags: { type: 'array', items: { type: 'string' }, description: 'Filter exported knowledge by tags' },
        knowledgeClassFilter: { type: 'array', items: { type: 'string' }, description: 'Filter by knowledge class' },
      },
      required: ['name'],
    },
  },
  {
    name: 'memory_import_bundle',
    description: 'Import a knowledge bundle into the current scope.',
    inputSchema: {
      type: 'object',
      properties: {
        bundle: { type: 'object', description: 'The MemoryBundle object to import' },
        conflictResolution: {
          type: 'string',
          enum: ['skip', 'overwrite', 'merge', 'trust_higher'],
          description: 'How to resolve conflicts with existing knowledge',
        },
        preserveTrust: { type: 'boolean', description: 'Preserve trust scores from the bundle (default: false)' },
      },
      required: ['bundle', 'conflictResolution'],
    },
  },
  {
    name: 'memory_refresh_documents',
    description: 'Re-ingest source documents that have changed since last ingestion.',
    inputSchema: {
      type: 'object',
      properties: {
        documents: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Document title (used to match stored documents)' },
              contentHash: { type: 'string', description: 'SHA-256 hash of current content' },
              content: { type: 'string', description: 'New content to re-ingest (required when document has changed)' },
            },
            required: ['title', 'contentHash'],
          },
          description: 'Documents to check and refresh',
        },
      },
      required: ['documents'],
    },
  },
];

function jsonResult(data: unknown): McpToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

function serializeContextResponse(
  context: MemoryContext,
  options: { includeDebug?: boolean } = {},
): Record<string, unknown> {
  return {
    currentObjective: context.currentObjective,
    sessionState: context.sessionState,
    activeTurnCount: context.activeTurns.length,
    workingMemory: context.workingMemory
      ? {
          summary: context.workingMemory.summary,
          key_entities: context.workingMemory.key_entities,
          topic_tags: context.workingMemory.topic_tags,
        }
      : null,
    relevantKnowledge: context.relevantKnowledge.map((knowledge) => ({
      id: knowledge.id,
      fact: knowledge.fact,
      fact_type: knowledge.fact_type,
      confidence: knowledge.confidence,
    })),
    activeObjectives: context.activeObjectives.map((objective) => ({
      id: objective.id,
      title: objective.title,
      status: objective.status,
      visibility_class: objective.visibility_class,
    })),
    associatedKnowledge: context.associatedKnowledge.map((knowledge) => ({
      id: knowledge.id,
      fact: knowledge.fact,
      fact_type: knowledge.fact_type,
      knowledge_class: knowledge.knowledge_class,
      trust_score: knowledge.trust_score,
    })),
    unresolvedWork: context.unresolvedWork,
    coordinationState: context.coordinationState
      ? {
          ownedClaims: context.coordinationState.ownedClaims.map(serializeWorkClaim),
          pendingInboundHandoffs: context.coordinationState.pendingInboundHandoffs.map(
            serializeHandoffRecord,
          ),
          pendingOutboundHandoffs: context.coordinationState.pendingOutboundHandoffs.map(
            serializeHandoffRecord,
          ),
          sharedWorkItems: context.coordinationState.sharedWorkItems.map((item) => ({
            id: item.id,
            title: item.title,
            status: item.status,
            visibility_class: item.visibility_class,
          })),
        }
      : null,
    tokenEstimate: context.tokenEstimate,
    ...(options.includeDebug
      ? {
          debugTrace: context.debugTrace,
          knowledgeSelectionReasons: context.knowledgeSelectionReasons,
        }
      : {}),
  };
}

function serializeActorRef(actor: ActorRef): Record<string, unknown> {
  return {
    actor_kind: actor.actor_kind,
    actor_id: actor.actor_id,
    system_id: actor.system_id,
    display_name: actor.display_name,
    metadata: actor.metadata,
  };
}

function serializeWorkClaim(claim: WorkClaim): Record<string, unknown> {
  return {
    id: claim.id,
    work_item_id: claim.work_item_id,
    actor: serializeActorRef(claim.actor),
    session_id: claim.session_id,
    claim_token: claim.claim_token,
    status: claim.status,
    claimed_at: claim.claimed_at,
    expires_at: claim.expires_at,
    released_at: claim.released_at,
    release_reason: claim.release_reason,
    source_event_id: claim.source_event_id,
    visibility_class: claim.visibility_class,
    version: claim.version,
  };
}

function serializeHandoffRecord(handoff: HandoffRecord): Record<string, unknown> {
  return {
    id: handoff.id,
    work_item_id: handoff.work_item_id,
    from_actor: serializeActorRef(handoff.from_actor),
    to_actor: serializeActorRef(handoff.to_actor),
    session_id: handoff.session_id,
    summary: handoff.summary,
    context_bundle_ref: handoff.context_bundle_ref,
    status: handoff.status,
    created_at: handoff.created_at,
    accepted_at: handoff.accepted_at,
    rejected_at: handoff.rejected_at,
    canceled_at: handoff.canceled_at,
    expires_at: handoff.expires_at,
    decision_reason: handoff.decision_reason,
    source_event_id: handoff.source_event_id,
    visibility_class: handoff.visibility_class,
    version: handoff.version,
  };
}

function serializeTimelineResult(result: TimelineResult): Record<string, unknown> {
  return {
    events: result.events,
    nextCursor: result.nextCursor,
  };
}

function serializeTemporalState(
  state: TemporalStateSnapshot<MemoryContext>,
  options: { includeDebug?: boolean } = {},
): Record<string, unknown> {
  return {
    asOf: state.asOf,
    exact: state.exact,
    cutoverAt: state.cutoverAt,
    watermarkEventId: state.watermarkEventId,
    context: serializeContextResponse(state.context, {
      includeDebug: options.includeDebug,
    }),
    sessionState: state.sessionState,
    turns: state.turns,
    workingMemory: state.workingMemory,
    knowledge: state.knowledge,
    workItems: state.workItems,
    workClaims: state.workClaims.map(serializeWorkClaim),
    handoffs: state.handoffs.map(serializeHandoffRecord),
    coordinationState: state.coordinationState
      ? {
          ownedClaims: state.coordinationState.ownedClaims.map(serializeWorkClaim),
          pendingInboundHandoffs: state.coordinationState.pendingInboundHandoffs.map(
            serializeHandoffRecord,
          ),
          pendingOutboundHandoffs: state.coordinationState.pendingOutboundHandoffs.map(
            serializeHandoffRecord,
          ),
          sharedWorkItems: state.coordinationState.sharedWorkItems,
        }
      : null,
    associations: state.associations,
    playbooks: state.playbooks,
  };
}

function errorResult(message: string): McpToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new McpValidationError(`Missing or invalid field: ${name}`);
  }
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new McpValidationError(`Invalid field: ${name}`);
  }
  return value;
}

function parseContextViewPolicy(value: unknown, name = 'view') {
  if (value == null) return undefined;
  return requireEnum(value, CONTEXT_VIEW_POLICIES, name);
}

function parseActorRef(value: unknown, name = 'actor'): ActorRef | undefined {
  if (value == null) return undefined;
  if (!isRecord(value)) {
    throw new McpValidationError(`Invalid field: ${name}`);
  }
  return {
    actor_kind: requireEnum(value.actor_kind, ACTOR_KINDS, `${name}.actor_kind`),
    actor_id: requireString(value.actor_id, `${name}.actor_id`),
    system_id: value.system_id == null ? null : requireString(value.system_id, `${name}.system_id`),
    display_name:
      value.display_name == null ? null : requireString(value.display_name, `${name}.display_name`),
    metadata: isRecord(value.metadata) ? value.metadata : null,
  };
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new McpValidationError(`Invalid field: ${name}`);
  }
  return value as T;
}

function parseLimit(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new McpValidationError('Invalid field: limit');
  }
  if (value > MAX_LIST_LIMIT) {
    throw new McpValidationError(`Invalid field: limit (maximum ${MAX_LIST_LIMIT})`);
  }
  return value;
}

function parseOptionalNonNegativeInteger(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new McpValidationError(`Invalid field: ${name} (must be a non-negative integer)`);
  }
  return value;
}

function parseRequiredFiniteInteger(
  value: unknown,
  name: string,
  options: {
    min?: number;
    max?: number;
  } = {},
): number {
  const parsed = parseOptionalFiniteInteger(value, { name, ...options }, failMcpValidation);
  if (parsed == null) {
    throw new McpValidationError(`Missing or invalid field: ${name}`);
  }
  return parsed;
}

function parseOptionalTemporalId(value: unknown, name: string): string | undefined {
  return parseOptionalTemporalIdValue(value, name, failMcpValidation);
}

function resolveScopeInput(
  fallbackScope: string | MemoryScope | undefined,
  args: Record<string, unknown>,
): string | MemoryScope {
  if (args.scope) {
    if (!isRecord(args.scope)) {
      throw new McpValidationError('Invalid scope override');
    }
    const raw = args.scope;
    const validated: MemoryScope = {
      tenant_id: requireString(raw.tenant_id, 'scope.tenant_id'),
      system_id: requireString(raw.system_id, 'scope.system_id'),
      scope_id: requireString(raw.scope_id, 'scope.scope_id'),
      workspace_id: optionalString(raw.workspace_id, 'scope.workspace_id'),
      collaboration_id: optionalString(raw.collaboration_id, 'scope.collaboration_id'),
    };
    normalizeScope(validated);
    return validated;
  }
  return fallbackScope ?? 'default';
}

/**
 * Creates a standalone MCP server handler that exposes memory operations as tools.
 *
 * This function returns the tools list and a callTool dispatcher. It can be used
 * with any MCP transport (stdio, SSE, etc.).
 *
 * For a ready-to-run stdio server, use `startMcpServer()`.
 */
export function createMcpServerHandler(config: McpServerConfig = {}) {
  const { defaultDiffMaxEvents, maxDiffMaxEvents } = resolveDiffEventCaps(
    config.defaultDiffMaxEvents,
    config.maxDiffMaxEvents,
  );
  const managers = new Map<string, MemoryManager>();
  const runtimes = new Map<string, MemoryRuntime>();
  const sessionManagers = new Map<string, MemoryManager>();
  const sessionRuntimes = new Map<string, MemoryRuntime>();
  let adapterPromise: Promise<{
    asyncAdapter: AsyncStorageAdapter;
    embeddingAdapter?: EmbeddingAdapter;
    close: () => Promise<void>;
  }> | null = null;

  function touchCache<T>(
    cache: Map<string, T>,
    key: string,
    value: T,
    limit: number,
    onEvict?: (evictedKey: string, evictedValue: T) => void,
  ): void {
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > limit) {
      const oldestEntry = cache.entries().next().value as [string, T] | undefined;
      if (!oldestEntry) break;
      const [oldestKey, oldestValue] = oldestEntry;
      cache.delete(oldestKey);
      onEvict?.(oldestKey, oldestValue);
    }
  }

  async function getAsyncAdapter(): Promise<{
    asyncAdapter: AsyncStorageAdapter;
    embeddingAdapter?: EmbeddingAdapter;
    close: () => Promise<void>;
  }> {
    if (!adapterPromise) {
      adapterPromise = (async () => {
        if (!config.databaseUrl && !process.env.MEMORY_DATABASE_URL) {
          const sqlite = createSQLiteAdapterWithEmbeddings(config.dbPath ?? ':memory:');
          return {
            asyncAdapter: wrapSyncAdapter(sqlite),
            embeddingAdapter: sqlite.embeddings,
            close: async () => {
              sqlite.close();
            },
          };
        }
        const moduleName = 'pg';
        const pgModule = await import(moduleName).catch(() => {
          throw new Error(
            'memory-layer: hosted Postgres mode requires the "pg" package. Install it with: npm install pg',
          );
        });
        const { createPostgresAdapter, createPostgresEmbeddingAdapter } = await import(
          '../adapters/postgres/index.js'
        );
        const Pool = pgModule.Pool ?? pgModule.default?.Pool;
        const pool = new Pool({
          connectionString: config.databaseUrl ?? process.env.MEMORY_DATABASE_URL,
        });
        const asyncAdapter = createPostgresAdapter(pool, { ownsPool: false });
        return {
          asyncAdapter,
          embeddingAdapter: createPostgresEmbeddingAdapter(pool),
          close: async () => {
            await pool.end();
          },
        };
      })();
    }
    return adapterPromise;
  }

  async function getManager(scopeInput: string | MemoryScope): Promise<MemoryManager> {
    const key =
      typeof scopeInput === 'string'
        ? `scope:${scopeInput}`
        : JSON.stringify(normalizeScope(scopeInput));
    const existing = managers.get(key);
    if (existing) {
      touchCache(managers, key, existing, MANAGER_CACHE_LIMIT);
      return existing;
    }
    const baseOptions: CreateMemoryOptions = {
      scope: scopeInput,
      summarizer: config.summarizer ?? 'extractive',
      extractor: config.extractor ?? 'regex',
      preset: config.preset,
      qualityMode: config.qualityMode,
      qualityTier: config.qualityTier,
      crossScopeLevel: config.crossScopeLevel,
      autoDetectWorkspace: config.autoDetectWorkspace,
      structuredClient: config.structuredClient,
    };
    const adapterContext = await getAsyncAdapter();
    const manager = createMemoryWithAsyncAdapter({
      ...baseOptions,
      asyncAdapter: adapterContext.asyncAdapter,
      embeddingAdapter: adapterContext.embeddingAdapter,
      closeAdapter: false,
    });
    touchCache(managers, key, manager, MANAGER_CACHE_LIMIT, (evictedKey) => {
      runtimes.delete(evictedKey);
    });
    return manager;
  }

  async function getRuntime(scopeInput: string | MemoryScope): Promise<MemoryRuntime> {
    const key =
      typeof scopeInput === 'string'
        ? `scope:${scopeInput}`
        : JSON.stringify(normalizeScope(scopeInput));
    const existing = runtimes.get(key);
    if (existing) {
      runtimes.delete(key);
      runtimes.set(key, existing);
      return existing;
    }
    const manager = await getManager(scopeInput);
    const runtime = createMemoryRuntime(manager, { snapshotMode: true });
    touchCache(runtimes, key, runtime, RUNTIME_CACHE_LIMIT);
    return runtime;
  }

  /**
   * Snapshot-specific runtime keyed by (scope, sessionId). The plain
   * getRuntime/getManager pair binds each scope to a single session, which
   * collapses snapshots across multiple URL-named sessions. Snapshot actions
   * must route to a manager whose bound sessionId matches the caller.
   */
  async function getSessionRuntime(
    scopeInput: string | MemoryScope,
    sessionId: string,
  ): Promise<MemoryRuntime> {
    const scopeKey =
      typeof scopeInput === 'string'
        ? `scope:${scopeInput}`
        : JSON.stringify(normalizeScope(scopeInput));
    const key = `${scopeKey}|session:${sessionId}`;
    const existing = sessionRuntimes.get(key);
    if (existing) {
      sessionRuntimes.delete(key);
      sessionRuntimes.set(key, existing);
      return existing;
    }
    const baseOptions: CreateMemoryOptions = {
      scope: scopeInput,
      sessionId,
      summarizer: config.summarizer ?? 'extractive',
      extractor: config.extractor ?? 'regex',
      preset: config.preset,
      qualityMode: config.qualityMode,
      qualityTier: config.qualityTier,
      crossScopeLevel: config.crossScopeLevel,
      autoDetectWorkspace: config.autoDetectWorkspace,
      structuredClient: config.structuredClient,
    };
    const adapterContext = await getAsyncAdapter();
    const manager = createMemoryWithAsyncAdapter({
      ...baseOptions,
      asyncAdapter: adapterContext.asyncAdapter,
      embeddingAdapter: adapterContext.embeddingAdapter,
      closeAdapter: false,
    });
    touchCache(
      sessionManagers,
      key,
      manager,
      SESSION_MANAGER_CACHE_LIMIT,
      (evictedKey, evictedManager) => {
        sessionRuntimes.delete(evictedKey);
        void evictedManager.close().catch(() => undefined);
      },
    );
    const runtime = createMemoryRuntime(manager, { snapshotMode: true });
    touchCache(sessionRuntimes, key, runtime, RUNTIME_CACHE_LIMIT);
    return runtime;
  }

  async function callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    try {
      const requestManager = await getManager(resolveScopeInput(config.scope, args));
      switch (name) {
        case 'memory_store_turn': {
          const turn = await requestManager.processTurn(
            requireEnum(args.role, ['user', 'assistant', 'system'], 'role'),
            requireString(args.content, 'content'),
            optionalString(args.actor, 'actor'),
          );
          return jsonResult({ stored: true, turnId: turn.id });
        }
        case 'memory_store_exchange': {
          const exchange = await requestManager.processExchange(
            requireString(args.userContent, 'userContent'),
            requireString(args.assistantContent, 'assistantContent'),
          );
          return jsonResult({
            stored: true,
            userTurnId: exchange.userTurn.id,
            assistantTurnId: exchange.assistantTurn.id,
            compacted: exchange.compactionResult !== null,
          });
        }
        case 'memory_get_context': {
          const context = await requestManager.getContext(
            args.relevanceQuery ? String(args.relevanceQuery) : undefined,
            {
              view: parseContextViewPolicy(args.view),
              viewer: parseActorRef(args.viewer, 'viewer'),
              includeCoordinationState: args.includeCoordinationState === true,
            },
          );
          return jsonResult(
            serializeContextResponse(context, {
              includeDebug: args.includeDebug === true,
            }),
          );
        }
        case 'memory_get_state_at': {
          const asOf = parseOptionalFiniteNumber(args.asOf, { name: 'asOf' }, failMcpValidation);
          if (asOf == null) {
            throw new McpValidationError('Missing or invalid field: asOf');
          }
          const state = await requestManager.getStateAt(asOf, {
            relevanceQuery: optionalString(args.relevanceQuery, 'relevanceQuery'),
            view: parseContextViewPolicy(args.view),
            viewer: parseActorRef(args.viewer, 'viewer'),
            includeCoordinationState: args.includeCoordinationState === true,
          });
          return jsonResult(
            serializeTemporalState(state, {
              includeDebug: args.includeDebug === true,
            }),
          );
        }
        case 'memory_get_timeline': {
          const timeline = await requestManager.getTimeline({
            sessionId: optionalString(args.sessionId, 'sessionId'),
            entityKind: args.entityKind as never,
            entityId: optionalString(args.entityId, 'entityId'),
            startAt: parseOptionalFiniteNumber(args.startAt, { name: 'startAt' }, failMcpValidation),
            endAt: parseOptionalFiniteNumber(args.endAt, { name: 'endAt' }, failMcpValidation),
            limit: parseLimit(args.limit),
            cursor: parseOptionalTemporalId(args.cursor, 'cursor'),
          });
          return jsonResult(serializeTimelineResult(timeline));
        }
        case 'memory_diff_state': {
          const from = parseOptionalFiniteNumber(args.from, { name: 'from' }, failMcpValidation);
          const to = parseOptionalFiniteNumber(args.to, { name: 'to' }, failMcpValidation);
          const maxEvents = parseOptionalFiniteInteger(
            args.maxEvents,
            { name: 'maxEvents', min: 1, max: maxDiffMaxEvents },
            failMcpValidation,
          );
          if (from == null || to == null) {
            throw new McpValidationError('Missing or invalid fields: from/to');
          }
          const diff = await requestManager.diffState(from, to, {
            sessionId: optionalString(args.sessionId, 'sessionId'),
            entityKind: args.entityKind as never,
            entityId: optionalString(args.entityId, 'entityId'),
            maxEvents: maxEvents ?? defaultDiffMaxEvents,
          });
          return jsonResult(diff);
        }
        case 'memory_list_events': {
          const events = await requestManager.listMemoryEvents({
            sessionId: optionalString(args.sessionId, 'sessionId'),
            entityKind: args.entityKind as never,
            entityId: optionalString(args.entityId, 'entityId'),
            startAt: parseOptionalFiniteNumber(args.startAt, { name: 'startAt' }, failMcpValidation),
            endAt: parseOptionalFiniteNumber(args.endAt, { name: 'endAt' }, failMcpValidation),
            limit: parseLimit(args.limit),
            cursor: parseOptionalTemporalId(args.cursor, 'cursor'),
          });
          return jsonResult(serializeTimelineResult(events));
        }
        case 'memory_search': {
          const searchOpts: Record<string, unknown> = {};
          if (args.limit != null) searchOpts.limit = parseLimit(args.limit);
          if (Array.isArray(args.tags)) searchOpts.tags = args.tags;
          const results = await requestManager.search(
            requireString(args.query, 'query'),
            Object.keys(searchOpts).length > 0 ? searchOpts : undefined,
          );
          return jsonResult({
            turns: results.turns.map((r) => ({
              id: r.item.id,
              role: r.item.role,
              content: r.item.content,
              rank: r.rank,
            })),
            knowledge: results.knowledge.map((r) => ({
              id: r.item.id,
              fact: r.item.fact,
              fact_type: r.item.fact_type,
              rank: r.rank,
            })),
          });
        }
        case 'memory_search_cross_scope': {
          const crossSearchOpts: Record<string, unknown> = {};
          if (args.limit != null) crossSearchOpts.limit = parseLimit(args.limit);
          if (Array.isArray(args.tags)) crossSearchOpts.tags = args.tags;
          const results = await requestManager.searchCrossScope(
            requireString(args.query, 'query'),
            (args.scopeLevel == null
              ? 'workspace'
              : requireEnum(args.scopeLevel, ['workspace', 'system', 'tenant'], 'scopeLevel')) as ScopeLevel,
            Object.keys(crossSearchOpts).length > 0 ? crossSearchOpts : undefined,
          );
          return jsonResult({
            knowledge: results.knowledge.map((r) => ({
              id: r.item.id,
              fact: r.item.fact,
              fact_type: r.item.fact_type,
              scope_id: r.item.scope_id,
              collaboration_id: r.item.collaboration_id,
              rank: r.rank,
            })),
          });
        }
        case 'memory_learn_fact': {
          const fact = await requestManager.learnFact(
            requireString(args.fact, 'fact'),
            requireEnum(args.factType, ['preference', 'entity', 'decision', 'constraint', 'reference'], 'factType') as FactType,
            (args.confidence == null
              ? 'high'
              : requireEnum(args.confidence, ['high', 'medium', 'low'], 'confidence')) as FactConfidence,
          );
          return jsonResult({ stored: true, knowledgeId: fact.id });
        }
        case 'memory_track_work': {
          const item = await requestManager.trackWorkItem(
            requireString(args.title, 'title'),
            requireEnum(args.kind ?? 'objective', ['objective', 'unresolved_work', 'constraint'], 'kind') as
              | 'objective'
              | 'unresolved_work'
              | 'constraint',
            requireEnum(args.status ?? 'open', ['open', 'in_progress', 'blocked', 'done'], 'status') as
              | 'open'
              | 'in_progress'
              | 'blocked'
              | 'done',
            optionalString(args.detail, 'detail'),
            {
              visibilityClass:
                args.visibility_class == null
                  ? undefined
                  : requireEnum(
                      args.visibility_class,
                      MEMORY_VISIBILITY_CLASSES,
                      'visibility_class',
                    ),
            },
          );
          return jsonResult({ tracked: true, workItemId: item.id });
        }
        case 'memory_update_work_item': {
          const item = await requestManager.updateWorkItem(parseRequiredFiniteInteger(args.id, 'id', { min: 1 }), {
            title: args.title != null ? requireString(args.title, 'title') : undefined,
            detail: args.detail != null ? optionalString(args.detail, 'detail') ?? null : undefined,
            status:
              args.status != null
                ? (requireEnum(args.status, ['open', 'in_progress', 'blocked', 'done'], 'status') as
                    | 'open'
                    | 'in_progress'
                    | 'blocked'
                    | 'done')
                : undefined,
            visibility_class:
              args.visibility_class != null
                ? requireEnum(args.visibility_class, MEMORY_VISIBILITY_CLASSES, 'visibility_class')
                : undefined,
          }, {
            expectedVersion: parseOptionalFiniteInteger(
              args.expectedVersion,
              { name: 'expectedVersion', min: 0 },
              failMcpValidation,
            ),
          });
          return jsonResult({ workItem: item });
        }
        case 'memory_claim_work_item': {
          const actor = parseActorRef(args.actor, 'actor');
          if (!actor) throw new McpValidationError('Missing or invalid field: actor');
          const claim = await requestManager.claimWorkItem({
            workItemId: parseRequiredFiniteInteger(args.workItemId, 'workItemId', { min: 1 }),
            actor,
            leaseSeconds: parseOptionalFiniteInteger(
              args.leaseSeconds,
              { name: 'leaseSeconds', min: 1 },
              failMcpValidation,
            ),
          });
          return jsonResult({ claim: serializeWorkClaim(claim) });
        }
        case 'memory_renew_work_claim': {
          const actor = parseActorRef(args.actor, 'actor');
          if (!actor) throw new McpValidationError('Missing or invalid field: actor');
          const claim = await requestManager.renewWorkClaim(
            parseRequiredFiniteInteger(args.claimId, 'claimId', { min: 1 }),
            actor,
            parseOptionalFiniteInteger(
              args.leaseSeconds,
              { name: 'leaseSeconds', min: 1 },
              failMcpValidation,
            ),
          );
          return jsonResult({ claim: claim ? serializeWorkClaim(claim) : null });
        }
        case 'memory_release_work_claim': {
          const actor = parseActorRef(args.actor, 'actor');
          if (!actor) throw new McpValidationError('Missing or invalid field: actor');
          const claim = await requestManager.releaseWorkClaim(
            parseRequiredFiniteInteger(args.claimId, 'claimId', { min: 1 }),
            actor,
            optionalString(args.reason, 'reason'),
          );
          return jsonResult({ claim: claim ? serializeWorkClaim(claim) : null });
        }
        case 'memory_list_work_claims': {
          const claims = await requestManager.listWorkClaims();
          return jsonResult({ claims: claims.map(serializeWorkClaim) });
        }
        case 'memory_handoff_work_item': {
          const fromActor = parseActorRef(args.fromActor, 'fromActor');
          const toActor = parseActorRef(args.toActor, 'toActor');
          if (!fromActor || !toActor) {
            throw new McpValidationError('Missing or invalid field: fromActor/toActor');
          }
          const handoff = await requestManager.handoffWorkItem({
            workItemId: parseRequiredFiniteInteger(args.workItemId, 'workItemId', { min: 1 }),
            fromActor,
            toActor,
            summary: requireString(args.summary, 'summary'),
            contextBundleRef: optionalString(args.contextBundleRef, 'contextBundleRef') ?? null,
            expiresAt:
              parseOptionalFiniteInteger(
                args.expiresAt,
                { name: 'expiresAt', min: 0 },
                failMcpValidation,
              ) ?? null,
          });
          return jsonResult({ handoff: serializeHandoffRecord(handoff) });
        }
        case 'memory_accept_handoff': {
          const actor = parseActorRef(args.actor, 'actor');
          if (!actor) throw new McpValidationError('Missing or invalid field: actor');
          const handoff = await requestManager.acceptHandoff(
            parseRequiredFiniteInteger(args.handoffId, 'handoffId', { min: 1 }),
            actor,
            optionalString(args.reason, 'reason'),
          );
          return jsonResult({ handoff: handoff ? serializeHandoffRecord(handoff) : null });
        }
        case 'memory_reject_handoff': {
          const actor = parseActorRef(args.actor, 'actor');
          if (!actor) throw new McpValidationError('Missing or invalid field: actor');
          const handoff = await requestManager.rejectHandoff(
            parseRequiredFiniteInteger(args.handoffId, 'handoffId', { min: 1 }),
            actor,
            optionalString(args.reason, 'reason'),
          );
          return jsonResult({ handoff: handoff ? serializeHandoffRecord(handoff) : null });
        }
        case 'memory_cancel_handoff': {
          const actor = parseActorRef(args.actor, 'actor');
          if (!actor) throw new McpValidationError('Missing or invalid field: actor');
          const handoff = await requestManager.cancelHandoff(
            parseRequiredFiniteInteger(args.handoffId, 'handoffId', { min: 1 }),
            actor,
            optionalString(args.reason, 'reason'),
          );
          return jsonResult({ handoff: handoff ? serializeHandoffRecord(handoff) : null });
        }
        case 'memory_list_pending_handoffs': {
          const handoffs = await requestManager.listPendingHandoffs({
            direction:
              args.direction == null
                ? 'all'
                : (requireEnum(args.direction, ['inbound', 'outbound', 'all'], 'direction') as
                    | 'inbound'
                    | 'outbound'
                    | 'all'),
          });
          return jsonResult({ handoffs: handoffs.map(serializeHandoffRecord) });
        }
        case 'memory_stream_changes': {
          const events = await requestManager.listMemoryEvents({
            cursor: parseOptionalTemporalId(args.cursor, 'cursor'),
            sessionId: optionalString(args.sessionId, 'sessionId'),
            entityKind: optionalString(args.entityKind, 'entityKind') as never,
            entityId: optionalString(args.entityId, 'entityId'),
            limit: parseLimit(args.limit),
          });
          return jsonResult(serializeTimelineResult(events));
        }
        case 'memory_force_compact': {
          const result = await requestManager.forceCompact();
          return jsonResult({
            compacted: result !== null,
            archivedTurnCount: result?.archivedTurnIds.length ?? 0,
          });
        }
        case 'memory_get_health': {
          const [context, diagnostics] = await Promise.all([
            requestManager.getContext(),
            requestManager.getRuntimeDiagnostics(),
          ]);
          return jsonResult({
            activeTurnCount: context.activeTurns.length,
            tokenEstimate: context.tokenEstimate,
            knowledgeCount: context.relevantKnowledge.length,
            objectiveCount: context.activeObjectives.length,
            unresolvedWorkCount: context.unresolvedWork.length,
            sessionStateUpdatedAt: context.sessionState.updatedAt,
            circuitBreakers: diagnostics.circuitBreakers,
          });
        }
        case 'memory_run_maintenance': {
          const report = await requestManager.runMaintenance();
          return jsonResult({
            expiredWorkingMemory: report.expiredWorkingMemoryIds.length,
            retiredKnowledge: report.retiredKnowledgeIds.length,
            deletedWorkItems: report.deletedWorkItemIds.length,
            deletedAssociationIds: report.deletedAssociationIds,
          });
        }
        case 'memory_search_episodes': {
          const episodeTimeRange = isRecord(args.timeRange)
            ? {
                start_at: parseOptionalFiniteNumber(
                  args.timeRange.start_at,
                  { name: 'timeRange.start_at' },
                  failMcpValidation,
                ),
                end_at: parseOptionalFiniteNumber(
                  args.timeRange.end_at,
                  { name: 'timeRange.end_at' },
                  failMcpValidation,
                ),
              }
            : undefined;
          const episodes = await requestManager.searchEpisodes({
            query: requireString(args.query, 'query'),
            detailLevel: args.detailLevel != null
              ? requireEnum(args.detailLevel, ['abstract', 'overview', 'full'], 'detailLevel') as EpisodeDetailLevel
              : undefined,
            limit: parseLimit(args.limit),
            timeRange: episodeTimeRange,
          });
          return jsonResult({ episodes });
        }
        case 'memory_summarize_episode': {
          const summary = await requestManager.summarizeEpisode(
            requireString(args.sessionId, 'sessionId'),
            args.detailLevel != null
              ? { detailLevel: requireEnum(args.detailLevel, ['abstract', 'overview', 'full'], 'detailLevel') as EpisodeDetailLevel }
              : undefined,
          );
          return jsonResult(summary);
        }
        case 'memory_reflect': {
          const reflectTimeRange = isRecord(args.timeRange)
            ? {
                start_at: parseOptionalFiniteNumber(
                  args.timeRange.start_at,
                  { name: 'timeRange.start_at' },
                  failMcpValidation,
                ),
                end_at: parseOptionalFiniteNumber(
                  args.timeRange.end_at,
                  { name: 'timeRange.end_at' },
                  failMcpValidation,
                ),
              }
            : undefined;
          const result = await requestManager.reflect({
            query: requireString(args.query, 'query'),
            detailLevel: args.detailLevel != null
              ? requireEnum(args.detailLevel, ['abstract', 'overview', 'full'], 'detailLevel') as EpisodeDetailLevel
              : undefined,
            includeEpisodic: args.includeEpisodic != null ? Boolean(args.includeEpisodic) : undefined,
            includeDeclarative: args.includeDeclarative != null ? Boolean(args.includeDeclarative) : undefined,
            limit: parseLimit(args.limit),
            timeRange: reflectTimeRange,
          });
          return jsonResult(result);
        }
        case 'memory_search_cognitive': {
          const cognitiveResult = await requestManager.searchCognitive({
            query: requireString(args.query, 'query'),
            types: Array.isArray(args.types) ? args.types as CognitiveMemoryType[] : undefined,
            limit: parseLimit(args.limit),
            minimumTrustScore: parseOptionalFiniteNumber(
              args.minimumTrustScore,
              { name: 'minimumTrustScore', min: 0, max: 1 },
              failMcpValidation,
            ),
            activeOnly: args.activeOnly != null ? Boolean(args.activeOnly) : undefined,
          });
          return jsonResult(cognitiveResult);
        }
        case 'memory_get_profile': {
          const profile = await requestManager.getProfile({
            view: args.view != null
              ? requireEnum(args.view, ['user', 'operator', 'workspace'], 'view') as ProfileView
              : undefined,
            sections: Array.isArray(args.sections)
              ? args.sections.map((s) => requireEnum(s, ['identity', 'preferences', 'communication', 'constraints', 'workflows'], 'sections')) as ProfileSection[]
              : undefined,
            minimumTrustScore: parseOptionalFiniteNumber(
              args.minimumTrustScore,
              { name: 'minimumTrustScore', min: 0, max: 1 },
              failMcpValidation,
            ),
            includeProvisional: args.includeProvisional != null ? Boolean(args.includeProvisional) : undefined,
            includeDisputed: args.includeDisputed != null ? Boolean(args.includeDisputed) : undefined,
          });
          return jsonResult({ profile });
        }
        case 'memory_create_playbook': {
          const playbook = await requestManager.createPlaybook({
            title: requireString(args.title, 'title'),
            description: requireString(args.description, 'description'),
            instructions: requireString(args.instructions, 'instructions'),
            references: Array.isArray(args.references) ? args.references.map(String) : undefined,
            templates: Array.isArray(args.templates) ? args.templates.map(String) : undefined,
            scripts: Array.isArray(args.scripts) ? args.scripts.map(String) : undefined,
            assets: Array.isArray(args.assets) ? args.assets.map(String) : undefined,
            tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
            status: args.status != null
              ? requireEnum(args.status, ['draft', 'active', 'deprecated', 'archived'], 'status') as 'draft' | 'active' | 'deprecated' | 'archived'
              : undefined,
          });
          return jsonResult({ playbook });
        }
        case 'memory_create_playbook_from_task': {
          const playbook = await requestManager.createPlaybookFromTask({
            title: requireString(args.title, 'title'),
            description: requireString(args.description, 'description'),
            sessionId: requireString(args.sessionId, 'sessionId'),
            tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
            sourceWorkingMemoryId: parseOptionalFiniteInteger(
              args.sourceWorkingMemoryId,
              { name: 'sourceWorkingMemoryId', min: 1 },
              failMcpValidation,
            ),
          });
          return jsonResult({ playbook });
        }
        case 'memory_search_playbooks': {
          const results = await requestManager.searchPlaybooks(
            requireString(args.query, 'query'),
            { limit: parseLimit(args.limit) },
          );
          // Return full playbook records with rank so consumers get the
          // same shape as the HTTP /v1/playbooks search response.
          return jsonResult({
            playbooks: results.map((r) => ({ ...r.item, rank: r.rank })),
          });
        }
        case 'memory_revise_playbook': {
          const playbookId = parseRequiredFiniteInteger(args.playbookId, 'playbookId', { min: 1 });
          const result = await requestManager.revisePlaybook(
            playbookId,
            requireString(args.newInstructions, 'newInstructions'),
            requireString(args.revisionReason, 'revisionReason'),
            optionalString(args.sourceSessionId, 'sourceSessionId'),
          );
          return jsonResult({ playbook: result.playbook, revision: result.revision });
        }
        case 'memory_use_playbook': {
          const playbookId = parseRequiredFiniteInteger(args.playbookId, 'playbookId', { min: 1 });
          await requestManager.recordPlaybookUse(playbookId);
          const playbook = await requestManager.getPlaybook(playbookId);
          return jsonResult({ playbook });
        }
        case 'memory_get_associations': {
          const kind = requireEnum(args.kind, ASSOCIATION_TARGET_KINDS, 'kind') as AssociationTargetKind;
          const id = parseRequiredFiniteInteger(args.id, 'id', { min: 1 });
          if (args.traverse) {
            const graph = await requestManager.traverseAssociations(kind, id, {
              maxDepth: parseOptionalNonNegativeInteger(args.maxDepth, 'maxDepth'),
              maxNodes: parseOptionalNonNegativeInteger(args.maxNodes, 'maxNodes'),
            });
            return jsonResult(graph);
          }
          const assocs = await requestManager.getAssociations(kind, id);
          return jsonResult(assocs);
        }
        case 'memory_add_association': {
          const sourceId = typeof args.source_id === 'number' && Number.isInteger(args.source_id) && args.source_id > 0
            ? args.source_id
            : (() => { throw new McpValidationError('Missing or invalid field: source_id (must be positive integer)'); })();
          const targetId = typeof args.target_id === 'number' && Number.isInteger(args.target_id) && args.target_id > 0
            ? args.target_id
            : (() => { throw new McpValidationError('Missing or invalid field: target_id (must be positive integer)'); })();
          let confidence: number | undefined;
          if (args.confidence !== undefined && args.confidence !== null) {
            if (typeof args.confidence !== 'number' || Number.isNaN(args.confidence) || args.confidence < 0 || args.confidence > 1) {
              throw new McpValidationError('Invalid field: confidence (must be a number in [0, 1])');
            }
            confidence = args.confidence;
          }
          const association = await requestManager.addAssociation({
            source_kind: requireEnum(args.source_kind, ASSOCIATION_TARGET_KINDS, 'source_kind') as AssociationTargetKind,
            source_id: sourceId,
            target_kind: requireEnum(args.target_kind, ASSOCIATION_TARGET_KINDS, 'target_kind') as AssociationTargetKind,
            target_id: targetId,
            association_type: requireEnum(args.association_type, ASSOCIATION_TYPES, 'association_type') as AssociationType,
            confidence,
          });
          return jsonResult({ created: true, associationId: association.id });
        }
        case 'memory_remove_association': {
          const id = parseRequiredFiniteInteger(args.id, 'id', { min: 1 });
          await requestManager.removeAssociation(id);
          return jsonResult({ deleted: true });
        }
        case 'memory_snapshot': {
          const action = requireEnum(args.action, ['capture', 'refresh', 'get'] as const, 'action');
          const sessionId = requireString(args.sessionId, 'sessionId');
          const runtime = await getSessionRuntime(resolveScopeInput(config.scope, args), sessionId);
          const relevanceQuery = optionalString(args.relevanceQuery, 'relevanceQuery');
          if (action === 'capture') {
            await runtime.startSession(relevanceQuery);
            const snapshot = runtime.getSnapshot();
            return jsonResult({ snapshot: snapshot ? { ...snapshot, sessionId } : null });
          }
          if (action === 'refresh') {
            const snapshot = await runtime.refreshSnapshot(relevanceQuery);
            return jsonResult({ snapshot: snapshot ? { ...snapshot, sessionId } : null });
          }
          // get
          const snapshot = runtime.getSnapshot();
          return jsonResult({ snapshot: snapshot ? { ...snapshot, sessionId } : null });
        }
        // --- Phase 5 tool handlers ---
        case 'memory_discover': {
          const report = await requestManager.discover({
            maxResults: parseLimit(args.maxResults) ?? undefined,
            minSurpriseScore: args.minSurpriseScore != null
              ? parseOptionalFiniteNumber(args.minSurpriseScore, { name: 'minSurpriseScore' }, failMcpValidation) ?? undefined
              : undefined,
            maxDepth: parseOptionalNonNegativeInteger(args.maxDepth, 'maxDepth'),
          });
          return jsonResult(report);
        }
        case 'memory_get_report': {
          const report = await requestManager.getGraphReport({
            tokenBudget: parseOptionalNonNegativeInteger(args.tokenBudget, 'tokenBudget'),
            includeSections: Array.isArray(args.includeSections) ? args.includeSections as string[] : undefined,
            filterByTags: Array.isArray(args.filterByTags) ? args.filterByTags as string[] : undefined,
          });
          return jsonResult(report);
        }
        case 'memory_get_facts_at': {
          const timestamp = parseRequiredFiniteInteger(args.timestamp, 'timestamp', { min: 0 });
          const factsResult = await requestManager.getFactsAt(timestamp);
          return jsonResult(factsResult);
        }
        case 'memory_reflect_knowledge': {
          const reflectionResult = await requestManager.reflectOnKnowledge({
            maxFacts: parseOptionalNonNegativeInteger(args.maxFacts, 'maxFacts'),
            includePlaybooks: args.includePlaybooks != null ? Boolean(args.includePlaybooks) : undefined,
            rateLimitKey: optionalString(args.rateLimitKey, 'rateLimitKey'),
          });
          return jsonResult(reflectionResult);
        }
        case 'memory_derive': {
          const derived = await requestManager.derive({
            outputTypes: Array.isArray(args.outputTypes) ? args.outputTypes as string[] : undefined,
            maxOutputs: parseOptionalNonNegativeInteger(args.maxOutputs, 'maxOutputs'),
          });
          return jsonResult(derived);
        }
        case 'memory_get_curation': {
          const curation = await requestManager.getCurationSummary(undefined, {
            since: args.since != null
              ? parseOptionalFiniteNumber(args.since, { name: 'since' }, failMcpValidation) ?? undefined
              : undefined,
            actionTypes: Array.isArray(args.actionTypes) ? args.actionTypes as unknown as import('../contracts/curation.js').CurationActionType[] : undefined,
            limit: parseLimit(args.limit),
          });
          return jsonResult(curation);
        }
        case 'memory_get_core_memory': {
          const coreMemory = await requestManager.getCoreMemory({
            tokenBudget: parseOptionalNonNegativeInteger(args.tokenBudget, 'tokenBudget'),
            includeClasses: Array.isArray(args.includeClasses) ? args.includeClasses as unknown as import('../contracts/types.js').KnowledgeClass[] : undefined,
          });
          return jsonResult(coreMemory);
        }
        case 'memory_set_aliases': {
          if (!isRecord(args.aliases)) {
            throw new McpValidationError('Missing or invalid field: aliases');
          }
          requestManager.setAliases(args.aliases as Record<string, string[]>);
          return jsonResult({ success: true });
        }
        case 'memory_get_aliases': {
          const aliases = requestManager.getAliases();
          return jsonResult({ aliases: aliases ?? {} });
        }
        case 'memory_get_alias_candidates': {
          const candidates = await requestManager.getAliasCandidates({
            threshold: args.threshold != null
              ? parseOptionalFiniteNumber(args.threshold, { name: 'threshold' }, failMcpValidation) ?? undefined
              : undefined,
            maxCandidates: parseOptionalNonNegativeInteger(args.maxCandidates, 'maxCandidates'),
          });
          return jsonResult({ candidates });
        }
        case 'memory_set_ontology': {
          if (!Array.isArray(args.entityTypes) || !Array.isArray(args.relationshipConstraints) || !Array.isArray(args.validationRules)) {
            throw new McpValidationError('Missing required fields: entityTypes, relationshipConstraints, validationRules');
          }
          requestManager.setOntology({
            entityTypes: args.entityTypes,
            relationshipConstraints: args.relationshipConstraints,
            validationRules: args.validationRules,
          });
          return jsonResult({ success: true });
        }
        case 'memory_get_ontology': {
          const ontology = requestManager.getOntology();
          return jsonResult({ ontology: ontology ?? null });
        }
        case 'memory_export_bundle': {
          const bundleName = requireString(args.name, 'name');
          const bundle = requestManager.exportBundle(bundleName, {
            includeTags: Array.isArray(args.includeTags) ? args.includeTags as string[] : undefined,
            knowledgeClassFilter: Array.isArray(args.knowledgeClassFilter) ? args.knowledgeClassFilter as unknown as import('../contracts/types.js').KnowledgeClass[] : undefined,
          });
          return jsonResult(bundle);
        }
        case 'memory_import_bundle': {
          if (!isRecord(args.bundle)) {
            throw new McpValidationError('Missing or invalid field: bundle');
          }
          const conflictResolution = requireEnum(
            args.conflictResolution,
            ['skip', 'overwrite', 'merge', 'trust_higher'] as const,
            'conflictResolution',
          );
          const importResult = requestManager.importBundle(args.bundle as any, {
            conflictResolution,
            targetScope: resolveScopeInput(config.scope, args) as MemoryScope,
            preserveTrust: args.preserveTrust != null ? Boolean(args.preserveTrust) : undefined,
          });
          return jsonResult(importResult);
        }
        case 'memory_refresh_documents': {
          if (!Array.isArray(args.documents)) {
            throw new McpValidationError('Missing or invalid field: documents');
          }
          const refreshResult = requestManager.refreshDocuments(args.documents);
          return jsonResult(refreshResult);
        }
        default:
          return errorResult(`Unknown tool: ${name}`);
      }
    } catch (error) {
      if (isMemoryDomainError(error)) {
        return errorResult(`Error in ${name}: ${error.message}`);
      }
      return errorResult(`Error in ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    tools: TOOLS,
    callTool,
    manager: undefined,
    async close() {
      managers.clear();
      sessionManagers.clear();
      sessionRuntimes.clear();
      runtimes.clear();
      if (adapterPromise) {
        const adapterContext = await adapterPromise;
        await adapterContext.close();
      }
    },
  };
}

/**
 * Starts a stdio-based MCP server.
 * This is the entry point for `npx memory-layer serve`.
 */
export async function startMcpServer(config: McpServerConfig = {}): Promise<void> {
  const handler = createMcpServerHandler(config);

  // MCP over stdio protocol
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin });

  rl.on('line', async (line: string) => {
    try {
      const message = JSON.parse(line);

      if (message.method === 'initialize') {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: {
                name: 'memory-layer',
                version: '4.0.0',
              },
            },
          }) + '\n',
        );
        return;
      }

      if (message.method === 'tools/list') {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              tools: handler.tools,
            },
          }) + '\n',
        );
        return;
      }

      if (message.method === 'tools/call') {
        if (!isRecord(message.params)) {
          throw new McpValidationError('Invalid tools/call params');
        }
        const result = await handler.callTool(
          message.params.name,
          isRecord(message.params.arguments) ? message.params.arguments : {},
        );
        process.stdout.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result,
          }) + '\n',
        );
        return;
      }

      // Respond to unknown methods
      if (message.id !== undefined) {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            error: {
              code: -32601,
              message: `Method not found: ${message.method}`,
            },
          }) + '\n',
        );
      }
    } catch (error) {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: {
            code: error instanceof McpValidationError ? -32602 : -32700,
            message: error instanceof Error ? error.message : String(error),
          },
        }) + '\n',
      );
    }
  });

  rl.on('close', async () => {
    await handler.close();
    process.exit(0);
  });
}

export { TOOLS as MCP_TOOLS };
export type { McpTool, McpToolResult };
