import { matchesScopeLevel, type MemoryScope, type ScopeLevel } from '../../contracts/identity.js';
import type { MemoryVisibilityClass } from '../../contracts/coordination.js';
import { isBaseVisible } from './visibility.js';

/**
 * Canonical result ordering shared across all adapters (Phase 3.4 / P3).
 *
 * The one-ordering-per-method contract is declared in JSDoc on
 * `contracts/storage.ts`; this comparator implements the most common canonical
 * order — `created_at ASC, then id ASC` — used by the list/range reads that
 * previously diverged across adapters (getWorkingMemoryBySession,
 * get*ByTimeRange(+CrossScope), getActiveWorkItems(+CrossScope)). `id ASC` is
 * the stable tie-break because `created_at` can be caller-supplied (imports,
 * time-travel) and therefore non-monotonic vs insertion order.
 */
export function byCreatedAtThenId<T extends { created_at: number; id: number }>(
  a: T,
  b: T,
): number {
  return a.created_at - b.created_at || a.id - b.id;
}

/**
 * Cross-scope read predicate (Phase 3.4 + 3.6): an item is returned iff it is
 * within the requested scope-level breadth AND permitted by its
 * visibility_class. The SQL adapters mirror this as `scopeLevelWhere AND
 * visibilityWhere`. Kept here so memory + SQL share one definition of "visible
 * cross-scope row".
 */
export function crossScopeVisiblePredicate<
  T extends MemoryScope & { visibility_class: MemoryVisibilityClass },
>(item: T, queryScope: MemoryScope, level: ScopeLevel): boolean {
  return (
    matchesScopeLevel(item, queryScope, level) &&
    isBaseVisible(item.visibility_class, item, queryScope)
  );
}
