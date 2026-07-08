/**
 * Shared adapter kernel (Phase 3.1). Single source of truth for search/ranking,
 * cross-scope visibility, and result-ordering logic used by the memory, SQLite,
 * and Postgres storage adapters. See the individual modules for the contracts
 * each helper enforces; adapters import from here rather than re-copying.
 */
export {
  DEFAULT_SEARCH_LIMIT,
  DEFAULT_PAGINATION_LIMIT,
  PHRASE_MATCH_BONUS,
  tokenizeSearch,
  scoreLexical,
  toSafeFtsQuery,
  normalizeBm25Rank,
  normalizeTsRank,
  resolveSearchOptions,
  resolvePaginationOptions,
} from './search.js';
export { isBaseVisible, eventVisibilityClass } from './visibility.js';
export { byCreatedAtThenId, crossScopeVisiblePredicate } from './ordering.js';
