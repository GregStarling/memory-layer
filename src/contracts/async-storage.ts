import type { StorageAdapter } from './storage.js';

/**
 * Promise-ify a single sync method signature, preserving its parameter list
 * exactly. A non-method member (there are none on {@link StorageAdapter}
 * today) passes through unchanged.
 */
type Asyncified<F> = F extends (...args: infer A) => infer R
  ? (...args: A) => Promise<Awaited<R>>
  : F;

/**
 * Structural async projection of every {@link StorageAdapter} member: the
 * return type is wrapped in a Promise while parameter types are preserved.
 *
 * `Exclude<StorageAdapter[K], undefined>` lets the conditional see through an
 * optional member's implicit `| undefined` so it still matches the function
 * branch; because this is a homomorphic mapped type (`[K in keyof …]`), the
 * original `?` optional modifier is re-applied to the mapped member, so
 * optional methods stay optional (and never collapse into a sync fallback).
 */
type MappedAsyncStorageAdapter = {
  [K in keyof StorageAdapter]: Asyncified<Exclude<StorageAdapter[K], undefined>>;
};

/**
 * Async-first storage adapter interface for remote backends (PostgreSQL, Redis, etc.).
 * Every method returns a Promise, enabling non-blocking I/O.
 *
 * For synchronous adapters (SQLite, in-memory), use `wrapSyncAdapter()` from
 * `memory-layer/adapters/sync-to-async` to convert a `StorageAdapter` into
 * an `AsyncStorageAdapter`.
 *
 * This type is DERIVED from {@link StorageAdapter} — the single source of
 * truth (Phase 6.1). Every member is the sync signature with a Promise-wrapped
 * return, with one deliberate exception modeled explicitly: `transaction`,
 * whose body is itself async here (`() => Promise<T>`) rather than the sync
 * `() => T` of the base contract. Adding/removing/retyping a method on
 * `StorageAdapter` therefore updates this contract automatically; any genuine
 * async-only divergence must be added to the explicit intersection below.
 */
export type AsyncStorageAdapter = Omit<MappedAsyncStorageAdapter, 'transaction'> & {
  transaction<T>(fn: () => Promise<T>): Promise<T>;
};
