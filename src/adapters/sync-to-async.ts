import type { StorageAdapter } from '../contracts/storage.js';
import type { AsyncStorageAdapter } from '../contracts/async-storage.js';

const NATIVE_SYNC_ADAPTER = Symbol('nativeSyncAdapter');

/**
 * Wraps a synchronous `StorageAdapter` into an `AsyncStorageAdapter`.
 * Every method call is wrapped in `Promise.resolve()` so sync adapters
 * (SQLite, in-memory) can be used in async-first codepaths without changes.
 *
 * The wrapper itself does not provide rollback semantics for arbitrary async
 * functions. Higher-level workflows that need true sync transactions can
 * detect the native adapter through `getNativeSyncAdapter()` and execute the
 * full write sequence inside `adapter.transaction(...)`.
 */
export function wrapSyncAdapter(adapter: StorageAdapter): AsyncStorageAdapter {
  const wrapped: AsyncStorageAdapter = {
    insertTurn: (input) => Promise.resolve(adapter.insertTurn(input)),
    insertTurns: (inputs) => Promise.resolve(adapter.insertTurns(inputs)),
    getTurnById: (id) => Promise.resolve(adapter.getTurnById(id)),
    getActiveTurns: (scope, sessionId) => Promise.resolve(adapter.getActiveTurns(scope, sessionId)),
    getActiveTurnsPaginated: (scope, options) =>
      Promise.resolve(adapter.getActiveTurnsPaginated(scope, options)),
    getTurnsByTimeRange: (scope, range) =>
      Promise.resolve(adapter.getTurnsByTimeRange(scope, range)),
    searchTurns: (scope, query, options) =>
      Promise.resolve(adapter.searchTurns(scope, query, options)),
    archiveTurn: (id, archivedAt, compactionLogId) =>
      Promise.resolve(adapter.archiveTurn(id, archivedAt, compactionLogId)),
    getArchivedTurnRange: (sessionId, startId, endId, scope) =>
      Promise.resolve(adapter.getArchivedTurnRange(sessionId, startId, endId, scope)),

    insertWorkingMemory: (input) => Promise.resolve(adapter.insertWorkingMemory(input)),
    getWorkingMemoryById: (id) => Promise.resolve(adapter.getWorkingMemoryById(id)),
    getWorkingMemoryBySession: (sessionId, scope) =>
      Promise.resolve(adapter.getWorkingMemoryBySession(sessionId, scope)),
    getActiveWorkingMemory: (scope, sessionId) =>
      Promise.resolve(adapter.getActiveWorkingMemory(scope, sessionId)),
    getLatestWorkingMemory: (scope, sessionId) =>
      Promise.resolve(adapter.getLatestWorkingMemory(scope, sessionId)),
    getWorkingMemoryByTimeRange: (scope, range) =>
      Promise.resolve(adapter.getWorkingMemoryByTimeRange(scope, range)),
    expireWorkingMemory: (id) => Promise.resolve(adapter.expireWorkingMemory(id)),
    markWorkingMemoryPromoted: (id, knowledgeMemoryId) =>
      Promise.resolve(adapter.markWorkingMemoryPromoted(id, knowledgeMemoryId)),

    insertKnowledgeMemory: (input) => Promise.resolve(adapter.insertKnowledgeMemory(input)),
    insertKnowledgeMemories: (inputs) =>
      Promise.resolve(adapter.insertKnowledgeMemories(inputs)),
    insertKnowledgeCandidate: (input) => Promise.resolve(adapter.insertKnowledgeCandidate(input)),
    insertKnowledgeCandidates: (inputs) =>
      Promise.resolve(adapter.insertKnowledgeCandidates(inputs)),
    getKnowledgeCandidateById: (id) => Promise.resolve(adapter.getKnowledgeCandidateById(id)),
    listKnowledgeCandidates: (scope, options) =>
      Promise.resolve(adapter.listKnowledgeCandidates(scope, options)),
    insertKnowledgeEvidence: (input) => Promise.resolve(adapter.insertKnowledgeEvidence(input)),
    insertKnowledgeEvidenceBatch: (inputs) =>
      Promise.resolve(adapter.insertKnowledgeEvidenceBatch(inputs)),
    listKnowledgeEvidenceForKnowledge: (knowledgeId) =>
      Promise.resolve(adapter.listKnowledgeEvidenceForKnowledge(knowledgeId)),
    listKnowledgeEvidenceForCandidate: (candidateId) =>
      Promise.resolve(adapter.listKnowledgeEvidenceForCandidate(candidateId)),
    promoteKnowledgeCandidate: (candidateId, input) =>
      Promise.resolve(adapter.promoteKnowledgeCandidate(candidateId, input)),
    getKnowledgeMemoryById: (id) => Promise.resolve(adapter.getKnowledgeMemoryById(id)),
    getActiveKnowledgeMemory: (scope) =>
      Promise.resolve(adapter.getActiveKnowledgeMemory(scope)),
    getActiveKnowledgeMemoryPaginated: (scope, options) =>
      Promise.resolve(adapter.getActiveKnowledgeMemoryPaginated(scope, options)),
    getActiveKnowledgeCrossScope: (scope, level) =>
      Promise.resolve(adapter.getActiveKnowledgeCrossScope(scope, level)),
    getKnowledgeSince: (scope, level, since) =>
      Promise.resolve(adapter.getKnowledgeSince(scope, level, since)),
    getKnowledgeByTimeRange: (scope, range) =>
      Promise.resolve(adapter.getKnowledgeByTimeRange(scope, range)),
    searchKnowledge: (scope, query, options) =>
      Promise.resolve(adapter.searchKnowledge(scope, query, options)),
    searchKnowledgeCrossScope: (scope, level, query, options) =>
      Promise.resolve(adapter.searchKnowledgeCrossScope(scope, level, query, options)),
    insertKnowledgeMemoryAudit: (input) =>
      Promise.resolve(adapter.insertKnowledgeMemoryAudit(input)),
    getRecentKnowledgeMemoryAudits: (scope, limit) =>
      Promise.resolve(adapter.getRecentKnowledgeMemoryAudits(scope, limit)),
    getKnowledgeMemoryAuditsForKnowledge: (scope, knowledgeId, limit) =>
      Promise.resolve(adapter.getKnowledgeMemoryAuditsForKnowledge(scope, knowledgeId, limit)),
    updateKnowledgeMemory: (id, patch) => Promise.resolve(adapter.updateKnowledgeMemory(id, patch)),
    touchKnowledgeMemory: (id) => Promise.resolve(adapter.touchKnowledgeMemory(id)),
    retireKnowledgeMemory: (id, retiredAt) =>
      Promise.resolve(adapter.retireKnowledgeMemory(id, retiredAt)),
    supersedeKnowledgeMemory: (oldId, newId) =>
      Promise.resolve(adapter.supersedeKnowledgeMemory(oldId, newId)),

    insertWorkItem: (input) => Promise.resolve(adapter.insertWorkItem(input)),
    getActiveWorkItems: (scope) => Promise.resolve(adapter.getActiveWorkItems(scope)),
    getWorkItemsByTimeRange: (scope, range) =>
      Promise.resolve(adapter.getWorkItemsByTimeRange(scope, range)),
    updateWorkItemStatus: (id, status) =>
      Promise.resolve(adapter.updateWorkItemStatus(id, status)),
    deleteWorkItem: (id) => Promise.resolve(adapter.deleteWorkItem(id)),

    upsertContextMonitor: (input) => Promise.resolve(adapter.upsertContextMonitor(input)),
    getContextMonitor: (scope) => Promise.resolve(adapter.getContextMonitor(scope)),

    insertCompactionLog: (input) => Promise.resolve(adapter.insertCompactionLog(input)),
    getCompactionLogById: (id) => Promise.resolve(adapter.getCompactionLogById(id)),
    getRecentCompactionLogs: (scope, limit) =>
      Promise.resolve(adapter.getRecentCompactionLogs(scope, limit)),

    async transaction<T>(fn: () => Promise<T>): Promise<T> {
      // Since all underlying operations are synchronous and JavaScript is
      // single-threaded, the await chains in fn() resolve as microtasks
      // within the same event-loop tick. No external I/O or user code can
      // interleave, providing effective atomicity.
      //
      // Note: this does NOT provide rollback semantics. If fn() rejects
      // after some operations have completed, those operations will have
      // already been applied to the sync adapter. For true transactional
      // rollback with a sync adapter, use the adapter's own transaction()
      // method directly.
      return fn();
    },

    async close() {
      adapter.close();
    },
  };

  Object.defineProperty(wrapped, NATIVE_SYNC_ADAPTER, {
    value: adapter,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  return wrapped;
}

export function getNativeSyncAdapter(adapter: AsyncStorageAdapter): StorageAdapter | null {
  return (adapter as AsyncStorageAdapter & { [NATIVE_SYNC_ADAPTER]?: StorageAdapter })[
    NATIVE_SYNC_ADAPTER
  ] ?? null;
}
