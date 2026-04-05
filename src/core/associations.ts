import type { MemoryScope } from '../contracts/identity.js';
import type { AsyncStorageAdapter } from '../contracts/async-storage.js';
import { UniqueConstraintError } from '../contracts/storage.js';
import type {
  Association,
  AssociationTargetKind,
  AssociationType,
  KnowledgeMemory,
} from '../contracts/types.js';

export interface AssociationNode {
  kind: AssociationTargetKind;
  id: number;
}

export interface AssociationGraph {
  nodes: AssociationNode[];
  edges: Association[];
}

export interface TraversalOptions {
  maxDepth?: number;
  maxNodes?: number;
}

export async function traverseAssociations(
  adapter: AsyncStorageAdapter,
  scope: MemoryScope,
  startKind: AssociationTargetKind,
  startId: number,
  options: TraversalOptions = {},
): Promise<AssociationGraph> {
  if (!Number.isInteger(startId) || startId <= 0) {
    throw new Error(`traverseAssociations: startId must be a positive integer, got ${startId}`);
  }
  const maxDepth = normalizeTraversalBound(options.maxDepth, 2, 'maxDepth');
  const maxNodes = normalizeTraversalBound(options.maxNodes, 20, 'maxNodes');

  const visitedKey = (kind: AssociationTargetKind, id: number) => `${kind}:${id}`;
  const visited = new Set<string>();
  const nodes: AssociationNode[] = [];
  const edges: Association[] = [];
  const edgeIds = new Set<number>();

  // Cap includes the start node. If maxNodes is 0 (or effectively unusable),
  // return an empty graph rather than silently allowing a single-node result.
  if (maxNodes < 1) {
    return { nodes, edges };
  }

  const queue: Array<{ kind: AssociationTargetKind; id: number; depth: number }> = [
    { kind: startKind, id: startId, depth: 0 },
  ];
  visited.add(visitedKey(startKind, startId));
  nodes.push({ kind: startKind, id: startId });

  while (queue.length > 0 && nodes.length < maxNodes) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;

    const [fromEdges, toEdges] = await Promise.all([
      adapter.getAssociationsFrom(current.kind, current.id, scope),
      adapter.getAssociationsTo(current.kind, current.id, scope),
    ]);

    for (const edge of [...fromEdges, ...toEdges]) {
      if (edgeIds.has(edge.id)) continue;

      // Determine the neighbor from the edge
      const neighborKind = edge.source_kind === current.kind && edge.source_id === current.id
        ? edge.target_kind
        : edge.source_kind;
      const neighborId = edge.source_kind === current.kind && edge.source_id === current.id
        ? edge.target_id
        : edge.source_id;

      const key = visitedKey(neighborKind, neighborId);
      const neighborAlreadyVisited = visited.has(key);

      if (!neighborAlreadyVisited && nodes.length < maxNodes) {
        visited.add(key);
        nodes.push({ kind: neighborKind, id: neighborId });
        queue.push({ kind: neighborKind, id: neighborId, depth: current.depth + 1 });
      }

      const neighborInNodeSet =
        neighborAlreadyVisited ||
        nodes.some((node) => node.kind === neighborKind && node.id === neighborId);
      if (neighborInNodeSet) {
        edgeIds.add(edge.id);
        edges.push(edge);
      }
    }
  }

  return { nodes, edges };
}

function normalizeTraversalBound(
  value: number | undefined,
  defaultValue: number,
  name: string,
): number {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(
      `traverseAssociations: ${name} must be a non-negative integer, got ${value}`,
    );
  }
  return value;
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2),
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function detectRelationType(
  source: KnowledgeMemory,
  target: KnowledgeMemory,
  similarity: number,
): AssociationType | null {
  const sameSlot =
    Boolean(source.slot_key) &&
    Boolean(target.slot_key) &&
    source.slot_key === target.slot_key;

  // Contradiction: same slot key with either negation mismatch OR
  // divergent fact text (different values asserted for the same slot).
  // Slot facts are assertions like "deploy:region = us-east-1" vs
  // "deploy:region = eu-west-1" — they must not be collapsed into supports.
  if (sameSlot) {
    const negationMismatch = source.is_negated !== target.is_negated;
    const divergentValues = !negationMismatch && similarity < 0.9;
    if (negationMismatch || divergentValues) {
      return 'contradicts';
    }
  }

  // Supersedes: same slot key, same polarity, target is newer, facts align
  if (
    sameSlot &&
    source.is_negated === target.is_negated &&
    target.created_at > source.created_at &&
    similarity >= 0.9
  ) {
    return 'supersedes';
  }

  // Supports: high similarity + same polarity (and not same-slot-divergent)
  if (similarity >= 0.4 && source.is_negated === target.is_negated) {
    return 'supports';
  }

  // Related: moderate similarity
  if (similarity >= 0.25) {
    return 'related_to';
  }

  return null;
}

export async function autoDetectAssociations(
  adapter: AsyncStorageAdapter,
  scope: MemoryScope,
  newKnowledge: KnowledgeMemory,
  existingKnowledge: KnowledgeMemory[],
): Promise<Association[]> {
  const created: Association[] = [];
  const newTokens = tokenize(newKnowledge.fact);

  for (const existing of existingKnowledge) {
    if (existing.id === newKnowledge.id) continue;

    const similarity = jaccardSimilarity(newTokens, tokenize(existing.fact));
    const relationType = detectRelationType(existing, newKnowledge, similarity);

    if (!relationType) continue;

    // For supersedes, new knowledge is the source (it supersedes the old)
    const sourceId = relationType === 'supersedes' ? newKnowledge.id : existing.id;
    const targetId = relationType === 'supersedes' ? existing.id : newKnowledge.id;

    try {
      const association = await adapter.insertAssociation({
        tenant_id: newKnowledge.tenant_id,
        system_id: newKnowledge.system_id,
        workspace_id: newKnowledge.workspace_id,
        collaboration_id: newKnowledge.collaboration_id,
        scope_id: newKnowledge.scope_id,
        source_kind: 'knowledge',
        source_id: sourceId,
        target_kind: 'knowledge',
        target_id: targetId,
        association_type: relationType,
        confidence: similarity,
        auto_generated: true,
      });
      created.push(association);
    } catch (err) {
      if (!isUniqueConstraintError(err)) {
        throw err;
      }
      // Unique constraint violation — association already exists, skip
    }
  }

  return created;
}

/**
 * Detect whether an adapter error represents a duplicate-edge unique
 * constraint violation.
 *
 * All bundled adapters throw the structured `UniqueConstraintError` class.
 * The code/message fallbacks below exist only for defence-in-depth against
 * third-party or older adapter implementations that have not adopted the
 * typed error yet.
 */
function isUniqueConstraintError(err: unknown): boolean {
  if (err instanceof UniqueConstraintError) return true;
  if (!err || typeof err !== 'object') return false;
  const anyErr = err as { code?: string; message?: string; kind?: string };
  if (anyErr.kind === 'UniqueConstraintError') return true;
  // Postgres: 23505 unique_violation
  if (anyErr.code === '23505') return true;
  // better-sqlite3: SQLITE_CONSTRAINT_UNIQUE
  if (anyErr.code === 'SQLITE_CONSTRAINT_UNIQUE') return true;
  const message = typeof anyErr.message === 'string' ? anyErr.message : '';
  if (message.includes('Association already exists')) return true;
  if (message.toLowerCase().includes('unique constraint')) return true;
  return false;
}
