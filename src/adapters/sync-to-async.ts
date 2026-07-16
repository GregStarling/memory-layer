import type { StorageAdapter } from '../contracts/storage.js';
import type { AsyncStorageAdapter } from '../contracts/async-storage.js';
import { NATIVE_SYNC_ADAPTER, getNativeSyncAdapter } from '../contracts/native-sync.js';

type AnyFn = (...args: unknown[]) => unknown;

/**
 * Wraps a synchronous `StorageAdapter` into an `AsyncStorageAdapter`.
 * Every method call is wrapped in `Promise.resolve()` so sync adapters
 * (SQLite, in-memory) can be used in async-first codepaths without changes.
 *
 * The facade is built by looping over the sync adapter's own function-valued
 * members rather than a hand-written per-method mapping (Phase 6.1): the
 * `AsyncStorageAdapter` shape is derived from `StorageAdapter`, so a new
 * contract method is Promise-ified here automatically. Notes on the loop:
 *
 * - **Spreadability.** The wrapped methods are assigned as own enumerable data
 *   properties, so callers can `{ ...wrapSyncAdapter(x) }` (many tests, and
 *   `createMemoryManager`, do). A `Proxy` would hide the keys from spread, so
 *   an eager loop is used instead.
 * - **Optional-method passthrough.** Only members actually present on the sync
 *   adapter are wrapped; an unimplemented optional method stays absent
 *   (reads as `undefined`) rather than becoming a wrapper over nothing.
 * - **`this`-safety.** Each wrapper invokes `adapter[key](...)` (not a detached
 *   function reference) so the underlying method runs with `this === adapter`;
 *   several sync methods call siblings via `this` (e.g. `insertTurns` →
 *   `this.insertTurn`).
 *
 * The wrapper itself does not provide rollback semantics for arbitrary async
 * functions. Higher-level workflows that need true sync transactions can
 * detect the native adapter through `getNativeSyncAdapter()` and execute the
 * full write sequence inside `adapter.transaction(...)`.
 */
export function wrapSyncAdapter(adapter: StorageAdapter): AsyncStorageAdapter {
  const wrapped: Record<string | symbol, unknown> = {};

  for (const key of Object.keys(adapter) as Array<keyof StorageAdapter>) {
    // `transaction` needs the native rollback path (below), not a naive
    // Promise.resolve of a sync body; everything else is a pure return->Promise
    // lift (including `close(): void` -> `Promise<void>`).
    if (key === 'transaction') continue;
    const member = adapter[key];
    if (typeof member !== 'function') continue;
    wrapped[key] = (...args: unknown[]): Promise<unknown> =>
      Promise.resolve((adapter[key] as AnyFn)(...args));
  }

  const asyncAdapter = wrapped as unknown as AsyncStorageAdapter;

  asyncAdapter.transaction = async function transaction<T>(
    fn: () => Promise<T> | T,
  ): Promise<T> {
    // Delegate to the native synchronous adapter's transaction so a failing
    // body rolls back (Phase 3.7). The sniff is internal to the wrapper —
    // core no longer reaches for getNativeSyncAdapter to do this. `async` so a
    // native synchronous rollback-throw surfaces as a rejected promise.
    const native = getNativeSyncAdapter(asyncAdapter);
    if (native && typeof native.transaction === 'function') {
      // A SYNCHRONOUS body is wrapped in the native transaction: in-memory
      // restores its snapshot on throw; SQLite issues BEGIN/ROLLBACK. This is
      // the path that yields real rollback.
      //
      // An ASYNC (promise-returning) body cannot be made atomic by a
      // synchronous engine: better-sqlite3 rejects a promise-returning
      // transaction function outright (verified empirically), and a
      // synchronous BEGIN/COMMIT cannot span a body whose post-await writes
      // run in a LATER microtask — running it inside the native transaction
      // and retrying would double-apply those writes. So async bodies run
      // directly (as before). Callers needing atomic multi-write on a sync
      // backend must pass a synchronous body (which is delegated here), the
      // pattern core/orchestrator.ts already uses for its atomic flows.
      const isAsyncFn =
        (fn as { constructor?: { name?: string } }).constructor?.name === 'AsyncFunction';
      if (!isAsyncFn) {
        return Promise.resolve(native.transaction(fn as () => T));
      }
    }
    return Promise.resolve(fn());
  };

  Object.defineProperty(asyncAdapter, NATIVE_SYNC_ADAPTER, {
    value: adapter,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  return asyncAdapter;
}
