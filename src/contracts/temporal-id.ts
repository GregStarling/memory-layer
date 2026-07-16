/**
 * Leaf module for the temporal-id scalar.
 *
 * `TemporalId` is the monotonic event-id type used across the temporal contract
 * and referenced by `coordination` records. Defining it here — importing
 * nothing — breaks the `coordination` ⇄ `temporal` type-only cycle the audit
 * found: `coordination` imports the scalar from this leaf instead of from the
 * heavyweight `temporal` module (which itself depends on `coordination`).
 * `temporal` re-exports it so existing `temporal.js` importers are unaffected.
 */

export type TemporalId = string;
