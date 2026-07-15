// Loads the retrieval dataset and enforces the authoring invariants at load
// time. If any invariant is violated the process throws — this keeps the
// categories honest as the dataset grows (a paraphrase case that accidentally
// shares a content token, or a distractor case with too few near-misses, is a
// hard failure, not a silent quality drift).

import { cases, CATEGORIES, KNOWN_WEAK_CATEGORIES } from './data/retrieval-cases.mjs';
import { tokenize, contentTokens, contentTokenOverlap } from './retrieval-tokens.mjs';

const MIN_TOTAL_CASES = 100;
const MIN_PER_CATEGORY = 15;
const MIN_DISTRACTORS = 5;

function fail(caseId, message) {
  throw new Error(`retrieval dataset invalid [${caseId ?? 'dataset'}]: ${message}`);
}

// Deterministic PRNG so the corpus shuffle is byte-identical across runs.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFromString(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

// Shuffle a case's corpus with a per-case seed. This removes the authoring
// artifact where the target (expected[0]) sat at index 0 and tie-breaks (both
// the grep baseline's index tie-break AND the system's equal-score fallback to
// insertion order) trivially favored it. After the shuffle, ties resolve at
// pseudo-random positions, so a ranker with no discriminating signal scores at
// chance — the honest floor. Both rankers consume the SAME shuffled order.
function shuffleCorpus(testCase) {
  const rng = mulberry32(seedFromString(testCase.id));
  const corpus = [...testCase.corpus];
  for (let i = corpus.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [corpus[i], corpus[j]] = [corpus[j], corpus[i]];
  }
  return { ...testCase, corpus };
}

export function loadDataset() {
  if (!Array.isArray(cases) || cases.length < MIN_TOTAL_CASES) {
    fail(null, `expected >= ${MIN_TOTAL_CASES} cases, got ${cases?.length ?? 0}`);
  }

  const seenIds = new Set();
  const byCategory = new Map(CATEGORIES.map((category) => [category, []]));

  for (const testCase of cases) {
    const { id, category, query, corpus, expected } = testCase;
    if (!id) fail(null, 'a case is missing an id');
    if (seenIds.has(id)) fail(id, 'duplicate case id');
    seenIds.add(id);

    if (!CATEGORIES.includes(category)) fail(id, `unknown category "${category}"`);
    if (typeof query !== 'string' || query.trim().length === 0) fail(id, 'empty query');
    if (!Array.isArray(corpus) || corpus.length < 2) fail(id, 'corpus must have >= 2 facts');
    if (!Array.isArray(expected) || expected.length === 0) fail(id, 'expected must be non-empty');

    const keys = corpus.map((entry) => entry.k);
    if (new Set(keys).size !== keys.length) fail(id, 'duplicate fact keys in corpus');
    for (const entry of corpus) {
      if (!entry.k) fail(id, 'a corpus fact is missing key k');
      if (typeof entry.t !== 'string' || entry.t.trim().length === 0) {
        fail(id, `fact "${entry.k}" has empty text`);
      }
    }
    for (const key of expected) {
      if (!keys.includes(key)) fail(id, `expected key "${key}" not present in corpus`);
    }

    const target = corpus.find((entry) => entry.k === expected[0]);

    if (category === 'paraphrase') {
      const overlap = contentTokenOverlap(query, target.t);
      if (overlap.length > 0) {
        fail(id, `paraphrase query shares content tokens with target: [${overlap.join(', ')}]`);
      }
      // A paraphrase must still carry meaning (not all stopwords).
      if (contentTokens(query).length < 2) fail(id, 'paraphrase query has too few content tokens');
    }

    if (category === 'distractor-resistance') {
      const distractors = corpus.filter((entry) => !expected.includes(entry.k));
      if (distractors.length < MIN_DISTRACTORS) {
        fail(id, `expected >= ${MIN_DISTRACTORS} distractors, got ${distractors.length}`);
      }
      const queryTokens = new Set(tokenize(query));
      for (const distractor of distractors) {
        const shares = tokenize(distractor.t).some((token) => queryTokens.has(token));
        if (!shares) fail(id, `distractor "${distractor.k}" shares no surface token with the query`);
      }
    }

    byCategory.get(category).push(shuffleCorpus(testCase));
  }

  for (const category of CATEGORIES) {
    const count = byCategory.get(category).length;
    if (count < MIN_PER_CATEGORY) {
      fail(null, `category "${category}" has ${count} cases, need >= ${MIN_PER_CATEGORY}`);
    }
  }

  const shuffledCases = CATEGORIES.flatMap((category) => byCategory.get(category));
  return { cases: shuffledCases, byCategory, categories: CATEGORIES, knownWeak: KNOWN_WEAK_CATEGORIES };
}
