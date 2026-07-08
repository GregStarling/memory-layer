import { normalizeScope, type MemoryScope } from '../../contracts/identity.js';
import type { MemoryVisibilityClass } from '../../contracts/coordination.js';

/**
 * Base cross-scope visibility predicate (Phase 3.6 / P6) — the ACCESS-CONTROL
 * gate that every adapter's cross-scope read path must apply, independent of any
 * context `view` policy.
 *
 * Given an item's `visibility_class` and scope, and the scope that is READING,
 * returns whether the item is permitted to surface to the reader. This is the
 * single source of truth the SQL adapters mirror in their WHERE clauses (SQLite
 * boolean expr; Postgres predicate). It is intentionally identical to the
 * `matchesVisibility` helper in core/context.ts; that copy predates this module
 * and should be de-duplicated onto this one by the core owner (it is outside the
 * Kernel file group).
 *
 * Invariant (P6): a `private` fact in scope A must NEVER surface to scope B at
 * any widening level. A `shared_collaboration` item surfaces only inside its own
 * (non-empty) collaboration_id. A `workspace` item surfaces only within the same
 * workspace. A `tenant` item surfaces anywhere in the tenant.
 *
 * NOTE this is the ACCESS ceiling; it is ANDed with scope-level widening
 * (see {@link crossScopeVisiblePredicate}) — the level is the requested breadth,
 * visibility is the permission. It is a SUPERSET of any view-based filter, so
 * layering a stricter context `view` on top never surfaces a hidden item.
 */
export function isBaseVisible(
  visibilityClass: MemoryVisibilityClass,
  itemScope: MemoryScope,
  queryScope: MemoryScope,
): boolean {
  const item = normalizeScope(itemScope);
  const query = normalizeScope(queryScope);
  if (item.tenant_id !== query.tenant_id) return false;
  switch (visibilityClass) {
    case 'tenant':
      return true;
    case 'workspace':
      return item.workspace_id === query.workspace_id;
    case 'shared_collaboration':
      return (
        item.workspace_id === query.workspace_id &&
        item.collaboration_id.length > 0 &&
        item.collaboration_id === query.collaboration_id
      );
    case 'private':
    default:
      return (
        item.system_id === query.system_id &&
        item.workspace_id === query.workspace_id &&
        item.collaboration_id === query.collaboration_id &&
        item.scope_id === query.scope_id
      );
  }
}

/**
 * Derive the base visibility_class of a memory EVENT row for the F4 event-log
 * cross-scope gate. Events have no top-level visibility_class column; they carry
 * the full entity snapshot (incl. fact text) in `payload.after` (or
 * `payload.before` for deletions). Read the snapshot's visibility_class,
 * defaulting to the MOST RESTRICTIVE class (`private`) when absent so an event
 * whose entity has no visibility concept never leaks across scope.
 *
 * SQL adapters MUST mirror this in their cross-scope event WHERE clause:
 *   Postgres: coalesce(payload->'after'->>'visibility_class',
 *                      payload->'before'->>'visibility_class', 'private')
 *   SQLite:   coalesce(json_extract(payload,'$.after.visibility_class'),
 *                      json_extract(payload,'$.before.visibility_class'), 'private')
 * then AND with isBaseVisible's equivalent scope predicate.
 */
export function eventVisibilityClass(
  payload: Record<string, unknown> | null | undefined,
): MemoryVisibilityClass {
  const snapshot = (payload?.after ?? payload?.before) as Record<string, unknown> | undefined;
  const vc = snapshot?.visibility_class;
  if (
    vc === 'tenant' ||
    vc === 'workspace' ||
    vc === 'shared_collaboration' ||
    vc === 'private'
  ) {
    return vc;
  }
  return 'private';
}
