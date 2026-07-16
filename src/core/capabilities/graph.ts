import { normalizeScope } from '../../contracts/identity.js';
import {
  ResourceNotFoundError,
  ScopeMismatchError,
  ValidationError,
} from '../../contracts/errors.js';
import type {
  Association,
  AssociationTargetKind,
  NewAssociation,
} from '../../contracts/types.js';
import type { DiscoverOptions, DiscoveryReport } from '../../contracts/discovery.js';
import type { GraphReportOptions, GraphReport } from '../../contracts/graph-report.js';
import { traverseAssociations, type AssociationGraph } from '../associations.js';
import { getGraphReport } from '../graph-report.js';
import { discover } from '../discover.js';
import { assertAssociationEndpointInScope, resolveSyncAdapter } from '../manager-support.js';
import type { CapabilityContext } from './context.js';

/**
 * Graph namespace (Phase 6.2): associations between memory entities, graph
 * traversal, whole-graph reporting, and cluster/alias discovery.
 */
export interface GraphCapability {
  addAssociation(
    input: Omit<NewAssociation, 'tenant_id' | 'system_id' | 'scope_id' | 'workspace_id' | 'collaboration_id'>,
  ): Promise<Association>;
  getAssociations(
    kind: AssociationTargetKind,
    id: number,
  ): Promise<{ from: Association[]; to: Association[] }>;
  traverseAssociations(
    kind: AssociationTargetKind,
    id: number,
    options?: { maxDepth?: number; maxNodes?: number },
  ): Promise<AssociationGraph>;
  removeAssociation(id: number): Promise<void>;
  getGraphReport(options?: GraphReportOptions): Promise<GraphReport>;
  discover(options?: DiscoverOptions): Promise<DiscoveryReport>;
}

export type GraphContext = Pick<CapabilityContext, 'asyncAdapter' | 'config'>;

export function createGraphCapability(ctx: GraphContext): GraphCapability {
  const { asyncAdapter, config } = ctx;

  return {
    async addAssociation(input) {
      // Validate source/target IDs are positive integers. Callers (HTTP/MCP)
      // only check typeof number, so this is the authoritative guard.
      if (!Number.isInteger(input.source_id) || input.source_id <= 0) {
        throw new ValidationError(
          `addAssociation: source_id must be a positive integer, got ${input.source_id}`,
        );
      }
      if (!Number.isInteger(input.target_id) || input.target_id <= 0) {
        throw new ValidationError(
          `addAssociation: target_id must be a positive integer, got ${input.target_id}`,
        );
      }
      if (input.source_kind === input.target_kind && input.source_id === input.target_id) {
        throw new ValidationError('addAssociation: self-referential associations are not allowed');
      }
      // Validate confidence is in [0, 1] when provided.
      if (input.confidence !== undefined) {
        if (
          typeof input.confidence !== 'number' ||
          Number.isNaN(input.confidence) ||
          input.confidence < 0 ||
          input.confidence > 1
        ) {
          throw new ValidationError(
            `addAssociation: confidence must be a number in [0, 1], got ${input.confidence}`,
          );
        }
      }
      // Resolve source and target: both must exist and belong to the caller's
      // scope. Without this, callers can create orphaned or cross-scope edges,
      // polluting the graph and weakening isolation guarantees.
      const norm = normalizeScope(config.scope);
      await assertAssociationEndpointInScope(
        asyncAdapter, norm, input.source_kind, input.source_id, 'source',
      );
      await assertAssociationEndpointInScope(
        asyncAdapter, norm, input.target_kind, input.target_id, 'target',
      );
      // When the caller does not specify provenance, infer from auto_generated:
      // user-created (non-auto) edges are 'extracted' with full confidence.
      const provenance = input.provenance ?? (input.auto_generated ? 'inferred' : 'extracted');
      const confidence = input.confidence ?? (input.auto_generated ? 0.8 : 1.0);
      return asyncAdapter.insertAssociation({
        ...input,
        ...norm,
        provenance,
        confidence,
      });
    },

    async getAssociations(kind, id) {
      const [from, to] = await Promise.all([
        asyncAdapter.getAssociationsFrom(kind, id, config.scope),
        asyncAdapter.getAssociationsTo(kind, id, config.scope),
      ]);
      return { from, to };
    },

    async traverseAssociations(kind, id, options) {
      return traverseAssociations(asyncAdapter, config.scope, kind, id, options);
    },

    async removeAssociation(id) {
      // Scope safety: verify the association belongs to the current scope by
      // checking the association row's own scope columns. Scanning through
      // active knowledge/playbooks/WM/work items would incorrectly reject
      // associations attached to archived/expired/orphaned nodes, leaving
      // stale edges permanently in the graph.
      if (!Number.isInteger(id) || id <= 0) {
        throw new ValidationError(`removeAssociation: id must be a positive integer, got ${id}`);
      }
      const association = await asyncAdapter.getAssociationById(id);
      if (!association) {
        throw new ResourceNotFoundError(`Association ${id} not found`);
      }
      const norm = normalizeScope(config.scope);
      if (
        association.tenant_id !== norm.tenant_id ||
        association.system_id !== norm.system_id ||
        association.workspace_id !== norm.workspace_id ||
        association.collaboration_id !== norm.collaboration_id ||
        association.scope_id !== norm.scope_id
      ) {
        throw new ScopeMismatchError(`Association ${id} not found in the current scope`);
      }
      await asyncAdapter.deleteAssociation(id);
    },

    async getGraphReport(options) {
      return getGraphReport(
        resolveSyncAdapter(config, asyncAdapter, 'getGraphReport()'),
        config.scope,
        options,
      );
    },

    async discover(options) {
      return discover(resolveSyncAdapter(config, asyncAdapter, 'discover()'), config.scope, options);
    },
  };
}
