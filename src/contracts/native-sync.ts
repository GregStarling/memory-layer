import type { StorageAdapter } from './storage.js';
import type { AsyncStorageAdapter } from './async-storage.js';

/**
 * Well-known capability marker for async adapters that are a Promise-lifted
 * facade over a real synchronous `StorageAdapter` (see
 * `adapters/sync-to-async.ts`). When present, the underlying sync adapter can
 * run a body inside its native `transaction(...)` for true rollback.
 *
 * The marker + accessor live in `contracts/` (not `adapters/`) so that `core`
 * can detect the capability without importing from the adapters layer, and the
 * adapters layer can stamp it — both depend on this contract, neither on the
 * other.
 *
 * This is deliberately a side-channel symbol rather than a member on
 * `AsyncStorageAdapter`: that interface is a homomorphic mapped type derived
 * from `StorageAdapter` (Phase 6.1). `StorageAdapter` has no native-sync
 * concept, so adding a member here would force an ad-hoc intersection onto the
 * mapped type and muddy that single-source-of-truth derivation. A non-enumerable
 * symbol keeps the type mechanical and the capability out of the public shape.
 */
export const NATIVE_SYNC_ADAPTER = Symbol('nativeSyncAdapter');

/**
 * Returns the underlying synchronous adapter if `adapter` was produced by
 * `wrapSyncAdapter`, else `null`.
 */
export function getNativeSyncAdapter(adapter: AsyncStorageAdapter): StorageAdapter | null {
  return (
    (adapter as AsyncStorageAdapter & { [NATIVE_SYNC_ADAPTER]?: StorageAdapter })[
      NATIVE_SYNC_ADAPTER
    ] ?? null
  );
}
