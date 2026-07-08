import type { PaginationOptions, SearchOptions } from '../../contracts/types.js';

/**
 * Shared search + ranking kernel (Phase 3.1 / 3.2).
 *
 * These helpers are the single source of truth for lexical tokenization,
 * relevance scoring, rank normalization, and option/pagination defaults across
 * ALL storage adapters (memory, SQLite, Postgres). Before Phase 3 each adapter
 * carried its own char-identical copies of `tokenize`/`scoreText`/
 * `resolveSearchOptions`; the copies silently drifted (the Postgres adapter was
 * missing `resolveSearchOptions` entirely, which is what regressed the
 * `activeOnly` default in Phase 0.4). Import from here; never re-copy.
 */

/** Default `SearchOptions.limit` when the caller omits it. */
export const DEFAULT_SEARCH_LIMIT = 10;
/** Default `PaginationOptions.limit` when the caller omits it. */
export const DEFAULT_PAGINATION_LIMIT = 25;
/**
 * Fraction of the lexical score reserved for the whole-query substring bonus.
 * The remainder is the query-term coverage fraction so the total stays in (0,1].
 */
export const PHRASE_MATCH_BONUS = 0.25;

/**
 * Lowercase + split on non-alphanumerics. Unicode-naive by design: the SQLite
 * and Postgres FTS engines tokenize differently, so this is used only for the
 * in-memory JS scorer and for turning free text into safe FTS terms. Adapters
 * must all agree on THIS tokenizer for the JS-side scoring paths.
 */
export function tokenizeSearch(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((token) => token.length > 0);
}

/**
 * JS lexical relevance score, normalized to (0,1], higher = better (Phase 3.2 P2).
 *
 * Contract: for any row that matches at least one query term the result is
 * strictly > 0 and <= 1. A row that matches every distinct query term scores
 * `1 - PHRASE_MATCH_BONUS`; the full whole-query substring adds the remaining
 * `PHRASE_MATCH_BONUS` up to exactly 1. Ranking order is identical to the
 * pre-Phase-3 `scoreText` (term-coverage fraction, phrase bonus as a tie-break);
 * only the SCALE changed (old formula could reach 1.25, breaking the (0,1]
 * cross-backend comparability that `rankKnowledge`'s lexical dimension needs).
 */
export function scoreLexical(query: string, text: string): number {
  const queryTokens = new Set(tokenizeSearch(query));
  const textTokens = new Set(tokenizeSearch(text));
  if (queryTokens.size === 0 || textTokens.size === 0) return 0;
  let matches = 0;
  for (const token of queryTokens) {
    if (textTokens.has(token)) matches += 1;
  }
  if (matches === 0) return 0;
  const coverage = matches / queryTokens.size; // (0,1]
  const phrase = text.toLowerCase().includes(query.toLowerCase()) ? 1 : 0;
  return coverage * (1 - PHRASE_MATCH_BONUS) + phrase * PHRASE_MATCH_BONUS;
}

/**
 * Turn arbitrary user text into a safe FTS5 MATCH string by treating every
 * token as a literal term (operator syntax is dropped, not honored). Shared so
 * SQLite sanitizes on the FIRST attempt, not only on error-retry (Phase 3.2).
 */
export function toSafeFtsQuery(query: string): string {
  return tokenizeSearch(query).join(' ');
}

/**
 * Normalize a SQLite FTS5 `bm25()` raw score to (0,1], higher = better (P2).
 *
 * IMPORTANT — direction. FTS5 `bm25()` returns a value that is MORE NEGATIVE for
 * a BETTER match (best rows sort first under the default `ORDER BY bm25(t)` ASC;
 * empirically verified against better-sqlite3). So the magnitude `m = -raw`
 * grows with match quality, and `m / (1 + m)` is monotonically increasing in
 * quality and bounded in (0,1). A matching row always has `raw < 0`, so `m > 0`
 * and the score is strictly positive.
 *
 * This DEVIATES from the `1/(1+max(0,-raw))` example in the manager decision
 * note: that formula is directionally inverted (it maps the BEST match toward 0
 * and the worst toward 1) and would preserve the Phase-0 "every hit clamps to a
 * constant" class of ranking bug in reverse. The (0,1] + higher=better contract
 * is the binding requirement; this helper honors it. Non-finite input → 0.
 */
export function normalizeBm25Rank(rawRank: number | null): number {
  if (rawRank == null || !Number.isFinite(rawRank)) return 0;
  const magnitude = Math.max(0, -rawRank);
  return magnitude / (1 + magnitude);
}

/**
 * Normalize a Postgres `ts_rank`/`ts_rank_cd` raw score to (0,1], higher =
 * better (P2). ts_rank is non-negative, higher = better, and unbounded above;
 * `r / (1 + r)` maps it into (0,1) preserving order. Non-positive / non-finite
 * input → 0.
 */
export function normalizeTsRank(rawRank: number | null): number {
  if (rawRank == null || !Number.isFinite(rawRank) || rawRank <= 0) return 0;
  return rawRank / (1 + rawRank);
}

/**
 * Resolve `SearchOptions` to a fully-defaulted object. The `activeOnly: true`
 * default is load-bearing: it is why superseded/retired records are excluded by
 * default on every adapter. All three adapters MUST resolve options through this
 * one function (Phase 0.4 root cause was a per-adapter copy drifting).
 */
export function resolveSearchOptions(options?: SearchOptions): Required<SearchOptions> {
  return {
    limit: options?.limit ?? DEFAULT_SEARCH_LIMIT,
    activeOnly: options?.activeOnly ?? true,
    includeProvisional: options?.includeProvisional ?? false,
    includeDisputed: options?.includeDisputed ?? false,
    minimumTrustScore: options?.minimumTrustScore ?? 0,
    knowledgeStates: options?.knowledgeStates ?? [],
    knowledgeClasses: options?.knowledgeClasses ?? [],
    tags: options?.tags ?? [],
    preferLocalTrusted: options?.preferLocalTrusted ?? false,
    preferLineageMemory: options?.preferLineageMemory ?? false,
  };
}

/** Resolve `PaginationOptions` to a fully-defaulted object (shared defaults). */
export function resolvePaginationOptions(
  options?: PaginationOptions,
): Required<PaginationOptions> {
  return {
    limit: options?.limit ?? DEFAULT_PAGINATION_LIMIT,
    offset: options?.offset ?? 0,
    cursor: options?.cursor ?? 0,
  };
}
