import { normalizeScope } from '../../contracts/identity.js';
import {
  ProviderUnavailableError,
  ResourceNotFoundError,
  ScopeMismatchError,
} from '../../contracts/errors.js';
import type {
  NewPlaybook,
  Playbook,
  PlaybookRevision,
  SearchOptions,
  SearchResult,
} from '../../contracts/types.js';
import {
  createPlaybookFromTask,
  findRelevantPlaybooks,
  revisePlaybook,
  type CreatePlaybookFromTaskInput,
} from '../playbook.js';
import type { CapabilityContext } from './context.js';

/**
 * Playbooks namespace (Phase 6.2): reusable procedure documents — CRUD,
 * task-synthesis, revision history, and relevance search.
 */
export interface PlaybooksCapability {
  createPlaybook(
    input: Omit<NewPlaybook, 'tenant_id' | 'system_id' | 'scope_id' | 'workspace_id' | 'collaboration_id'>,
  ): Promise<Playbook>;
  createPlaybookFromTask(input: CreatePlaybookFromTaskInput): Promise<Playbook>;
  revisePlaybook(
    playbookId: number,
    newInstructions: string,
    revisionReason: string,
    sourceSessionId?: string | null,
  ): Promise<{ playbook: Playbook; revision: PlaybookRevision }>;
  getPlaybook(id: number): Promise<Playbook | null>;
  listPlaybooks(): Promise<Playbook[]>;
  searchPlaybooks(query: string, options?: SearchOptions): Promise<SearchResult<Playbook>[]>;
  updatePlaybook(
    id: number,
    patch: {
      title?: string;
      description?: string;
      instructions?: string;
      references?: string[];
      templates?: string[];
      scripts?: string[];
      assets?: string[];
      tags?: string[];
      status?: Playbook['status'];
    },
  ): Promise<Playbook | null>;
  recordPlaybookUse(id: number): Promise<void>;
}

export type PlaybooksContext = Pick<CapabilityContext, 'asyncAdapter' | 'config'>;

export function createPlaybooksCapability(ctx: PlaybooksContext): PlaybooksCapability {
  const { asyncAdapter, config } = ctx;

  return {
    async createPlaybook(input) {
      return asyncAdapter.insertPlaybook({ ...input, ...config.scope });
    },

    async createPlaybookFromTask(input) {
      if (!config.structuredClient) {
        throw new ProviderUnavailableError(
          'createPlaybookFromTask requires a structuredClient in MemoryManagerConfig',
        );
      }
      return createPlaybookFromTask(
        { adapter: asyncAdapter, scope: config.scope, client: config.structuredClient },
        input,
      );
    },

    async revisePlaybook(playbookId, newInstructions, revisionReason, sourceSessionId) {
      return revisePlaybook(asyncAdapter, config.scope, playbookId, newInstructions, revisionReason, sourceSessionId);
    },

    async getPlaybook(id) {
      const playbook = await asyncAdapter.getPlaybookById(id);
      if (!playbook) return null;
      const norm = normalizeScope(config.scope);
      if (
        playbook.tenant_id !== norm.tenant_id ||
        playbook.system_id !== norm.system_id ||
        playbook.workspace_id !== norm.workspace_id ||
        playbook.collaboration_id !== norm.collaboration_id ||
        playbook.scope_id !== norm.scope_id
      ) {
        return null;
      }
      return playbook;
    },

    async listPlaybooks() {
      return asyncAdapter.getActivePlaybooks(config.scope);
    },

    async searchPlaybooks(query, options) {
      return findRelevantPlaybooks(asyncAdapter, config.scope, query, options);
    },

    async updatePlaybook(id, patch) {
      const playbook = await asyncAdapter.getPlaybookById(id);
      if (!playbook) return null;
      const norm = normalizeScope(config.scope);
      if (
        playbook.tenant_id !== norm.tenant_id ||
        playbook.system_id !== norm.system_id ||
        playbook.workspace_id !== norm.workspace_id ||
        playbook.collaboration_id !== norm.collaboration_id ||
        playbook.scope_id !== norm.scope_id
      ) {
        return null;
      }
      return asyncAdapter.updatePlaybook(id, patch);
    },

    async recordPlaybookUse(id) {
      const playbook = await asyncAdapter.getPlaybookById(id);
      if (!playbook) {
        throw new ResourceNotFoundError(`Playbook ${id} not found`);
      }
      const norm = normalizeScope(config.scope);
      if (
        playbook.tenant_id !== norm.tenant_id ||
        playbook.system_id !== norm.system_id ||
        playbook.workspace_id !== norm.workspace_id ||
        playbook.collaboration_id !== norm.collaboration_id ||
        playbook.scope_id !== norm.scope_id
      ) {
        throw new ScopeMismatchError(`Playbook ${id} does not belong to the requested scope`);
      }
      return asyncAdapter.recordPlaybookUse(id);
    },
  };
}
