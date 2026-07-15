// Ranking metrics for the retrieval eval: MRR and recall@k, computed from
// ordinal rankings (arrays of fact keys), so they are stable regardless of the
// tiny wall-clock jitter in recency scoring as long as the ranking order does
// not flip. All reported numbers are rounded to 4 decimals for byte-identical
// output across runs.

export const RECALL_KS = [1, 5];

export function round4(value) {
  return Math.round(value * 10000) / 10000;
}

// rankedKeys: ordered array of fact keys the ranker returned (best first).
// relevantKeys: the set of correct keys for the case.
// Reciprocal rank = 1 / (1-based position of the first relevant key), 0 if none.
export function reciprocalRank(rankedKeys, relevantKeys) {
  const relevant = new Set(relevantKeys);
  for (let index = 0; index < rankedKeys.length; index += 1) {
    if (relevant.has(rankedKeys[index])) return 1 / (index + 1);
  }
  return 0;
}

// Fraction of relevant keys that appear in the top-k of the ranking.
export function recallAtK(rankedKeys, relevantKeys, k) {
  const relevant = new Set(relevantKeys);
  if (relevant.size === 0) return 0;
  const topK = rankedKeys.slice(0, k);
  let hit = 0;
  for (const key of topK) {
    if (relevant.has(key)) hit += 1;
  }
  return hit / relevant.size;
}

// Aggregate a list of per-case results into MRR + recall@k means.
// results: [{ rankedKeys, relevantKeys }]
export function aggregate(results) {
  const n = results.length;
  if (n === 0) {
    return { count: 0, mrr: 0, recall: Object.fromEntries(RECALL_KS.map((k) => [k, 0])) };
  }
  let mrrSum = 0;
  const recallSums = Object.fromEntries(RECALL_KS.map((k) => [k, 0]));
  for (const { rankedKeys, relevantKeys } of results) {
    mrrSum += reciprocalRank(rankedKeys, relevantKeys);
    for (const k of RECALL_KS) recallSums[k] += recallAtK(rankedKeys, relevantKeys, k);
  }
  return {
    count: n,
    mrr: round4(mrrSum / n),
    recall: Object.fromEntries(RECALL_KS.map((k) => [k, round4(recallSums[k] / n)])),
  };
}
