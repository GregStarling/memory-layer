/**
 * Leaf module for the memory visibility taxonomy.
 *
 * `MemoryVisibilityClass` is a foundational value used by both `coordination`
 * (which owns the coordination/handoff records) and `types` (which annotates
 * memory records). Defining it here — importing nothing — breaks the
 * `types` ⇄ `coordination` type-only cycle the audit found. Both modules import
 * from this leaf; `coordination` additionally re-exports it so existing
 * `coordination.js` importers (incl. the root barrel) are unaffected.
 */

export type MemoryVisibilityClass = 'private' | 'shared_collaboration' | 'workspace' | 'tenant';

export const MEMORY_VISIBILITY_CLASSES: readonly MemoryVisibilityClass[] = [
  'private',
  'shared_collaboration',
  'workspace',
  'tenant',
];
