// The two rankers the eval compares over the SAME dataset in the SAME run.
//
//  runSystemCase   — the real retrieval path: buildMemoryContext with sqlite
//                    FTS lexical search + local hashed-trigram semantic search
//                    + trust/recency/class weighting. Deterministic and offline
//                    (no API keys): the embedding generator is the in-repo
//                    hashed-trigram one.
//
//  runBaselineCase — a pure exact-token-overlap "grep" ranker: score a fact by
//                    the number of times the query's content tokens occur in
//                    it (multiplicity, no IDF, no trigrams, no semantics, no
//                    trust/recency). This is the dumb baseline the full system
//                    must beat by a measured margin (D2).

import {
  buildMemoryContext,
  createSQLiteAdapterWithEmbeddings,
  wrapSyncAdapter,
  createLocalEmbeddingGenerator,
} from '../dist/index.js';
import { tokenize, contentTokens } from './retrieval-tokens.mjs';

const EMBEDDING_DIMENSIONS = 384;
const DAY_SECONDS = 86400;

// Single shared generator. Each text is embedded in its own single-element
// batch, which pins the local generator's inverse-document-frequency term to a
// constant 1 for every feature — so fact vectors and the query vector are
// weighted on the same scale and the result is fully deterministic.
const embed = createLocalEmbeddingGenerator({ dimensions: EMBEDDING_DIMENSIONS });
async function embedOne(text) {
  const [vector] = await embed([text]);
  return vector;
}

const FACT_DEFAULTS = {
  cls: 'project_fact',
  ft: 'reference',
  trust: 0.8,
  ageDays: 30,
  state: 'trusted',
};

export async function runSystemCase(testCase, nowSeconds) {
  const adapter = createSQLiteAdapterWithEmbeddings(':memory:');
  const asyncAdapter = wrapSyncAdapter(adapter);
  const scope = { tenant_id: 'eval', system_id: 'retrieval', scope_id: testCase.id };
  const idToKey = new Map();

  try {
    for (const entry of testCase.corpus) {
      const fact = { ...FACT_DEFAULTS, ...entry };
      const row = adapter.insertKnowledgeMemory({
        ...scope,
        fact: fact.t,
        fact_type: fact.ft,
        knowledge_class: fact.cls,
        knowledge_state: fact.state,
        trust_score: fact.trust,
        source: 'manual',
        confidence: 'high',
        created_at: nowSeconds - fact.ageDays * DAY_SECONDS,
      });
      idToKey.set(row.id, entry.k);
      const vector = await embedOne(fact.t);
      adapter.embeddings.storeEmbedding(row.id, vector, {
        model: 'unknown',
        dimensions: EMBEDDING_DIMENSIONS,
      });
    }

    const queryVector = await embedOne(testCase.query);
    const context = await buildMemoryContext(asyncAdapter, scope, {
      relevanceQuery: testCase.query,
      queryVector,
      embeddingAdapter: adapter.embeddings,
      embeddingFilter: { dimensions: EMBEDDING_DIMENSIONS },
      maxKnowledgeItems: 25,
      policy: { touchSelectedKnowledge: false },
    });

    const rankedKeys = context.relevantKnowledge
      .map((item) => idToKey.get(item.id))
      .filter((key) => key != null);
    return rankedKeys;
  } finally {
    adapter.close();
  }
}

export function runBaselineCase(testCase) {
  const queryTerms = contentTokens(testCase.query);
  const scored = testCase.corpus.map((entry, index) => {
    const factTokens = tokenize(entry.t);
    let score = 0;
    for (const token of factTokens) {
      if (queryTerms.includes(token)) score += 1;
    }
    return { key: entry.k, score, index };
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((entry) => entry.key);
}
