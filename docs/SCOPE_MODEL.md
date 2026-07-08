# Scope & Visibility Model

Authoritative reference for how records are partitioned, widened, and gated
across scopes. Phase 3.9 (item 3.9) design decision + contract. The code of
record is `src/contracts/identity.ts` (widening) and
`src/adapters/shared/visibility.ts` (visibility gate); this document explains the
model and the deliberate caveats.

## Scope fields

A `MemoryScope` has five fields (normalized via `normalizeScope`):

| field              | meaning                                                        | default when unset |
|--------------------|---------------------------------------------------------------|--------------------|
| `tenant_id`        | Hard multi-tenant partition. Never crossed.                   | required           |
| `system_id`        | Calling agent/system identity. NOT a sharing boundary.        | required           |
| `workspace_id`     | Workspace / project boundary.                                 | `'default'`        |
| `collaboration_id` | Explicit shared-memory boundary across systems.               | `''` (none)        |
| `scope_id`         | Task / thread / branch boundary.                              | required           |

## Two independent dimensions

Cross-scope reads combine two orthogonal checks, ANDed together:

1. **Breadth — `matchesScopeLevel(item, query, level)`** (`identity.ts`). How wide
   the caller asked to look.
2. **Visibility — `isBaseVisible(visibility_class, item, query)`**
   (`shared/visibility.ts`). Whether the item's owner permits the reader to see
   it, given the item's `visibility_class`.

An item surfaces on a cross-scope read iff **breadth AND visibility** both pass.
This is enforced in every adapter's `*CrossScope` reads and the cross-scope
temporal read `getKnowledgeSince` (Phase 3.6 / P6). It is applied unconditionally
— not only when a context `view` is set — and is a superset of any stricter
context view layered on top.

## Widening matrix (breadth)

Fields compared as normalized. `(ignored)` = not compared at that level.

| level       | tenant_id | system_id | workspace_id | collaboration_id | scope_id |
|-------------|-----------|-----------|--------------|------------------|----------|
| `tenant`    | =         | (ignored) | (ignored)    | (ignored)        | (ignored)|
| `system`    | =         | =         | (ignored)    | (ignored)        | (ignored)|
| `workspace` | =         | (ignored) | =            | (ignored)        | (ignored)|
| `scope`     | =         | =         | =            | =                | =        |

### Caveats (documented, not accidental)

- **`workspace` widening ignores `system_id`.** A workspace is shared across the
  systems/agents working in it. Cross-system leakage of records that are not
  workspace-visible is prevented by the **visibility gate**, not by the level.
- **No widening level filters `collaboration_id`.** The collaboration dimension
  lives entirely in **visibility** (`shared_collaboration`), see below.
- **`workspace_id` defaults to `'default'`.** Unrelated systems that never set a
  workspace co-mingle at `workspace` widening. Callers isolating systems within a
  tenant must set an explicit `workspace_id`.

## Visibility matrix (access gate)

Given an item's `visibility_class` and the READING scope (same tenant assumed;
different tenant always denied):

| visibility_class       | surfaces to a reader when …                                              |
|------------------------|-------------------------------------------------------------------------|
| `private`              | reader's `system_id` AND `workspace_id` AND `collaboration_id` AND `scope_id` all equal the item's (i.e. the item's own scope only) |
| `shared_collaboration` | same `workspace_id` AND item's `collaboration_id` is non-empty AND equals the reader's |
| `workspace`            | same `workspace_id`                                                      |
| `tenant`               | anywhere in the tenant                                                   |

### Decision: `shared_collaboration` is gated by `collaboration_id` (3.9)

The 3.9 recommendation ("add collaboration as a real filter dimension for
`shared_collaboration` items") is implemented at the **visibility** layer rather
than as a new widening level: `isBaseVisible` requires a **matching, non-empty
`collaboration_id`** for `shared_collaboration` items. Because the visibility
gate is ANDed onto every cross-scope read, a `shared_collaboration` record never
surfaces outside its collaboration_id — satisfying the 3.9 AC — without adding a
`collaboration` scope level. Widening still uses the four existing levels; the
collaboration filter is a property of the item's declared visibility.

### Invariant (P6)

> A `private` fact in scope A must never surface to scope B at any widening level.

Holds by construction: `private` requires full scope equality in `isBaseVisible`,
so a widened read from a different `scope_id`/`system_id` can never admit another
scope's private record.

## Tenant-id tightening (3.9)

`source_documents.tenant_id` must be non-empty. The in-memory adapter already
enforces this: `insertSourceDocument` runs `normalizeScope`, which throws on an
empty `tenant_id`. The SQL schemas should drop the `DEFAULT ''` and make the
column `NOT NULL` without a default (`sqlite/schema.ts`, `postgres/schema.sql`) —
mirrored by the SQLite/Postgres workers.
