// Shared tokenization + stopword helpers for the retrieval eval.
//
// `tokenize` mirrors the local hashed-trigram embedding tokenizer
// (src/embeddings/local.ts): lowercase, split on non-alphanumeric, drop
// single-character tokens. Keeping it identical means the "content-token
// overlap" the eval reasons about is the SAME notion of a token the system's
// lexical (FTS) and semantic (trigram) paths operate on — so a paraphrase case
// proven to have zero content-token overlap is genuinely denied every
// whole-token signal the system has, and only trigram character overlap can
// possibly rescue it. That is the honest definition of "offline-weak".

export function tokenize(text) {
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((token) => token.length > 1);
}

// Function words + high-frequency scaffolding that carry no retrieval signal.
// Content-overlap enforcement (paraphrase category) IGNORES these — two
// sentences are allowed to both say "the" / "how" / "do" and still count as
// having zero *content* overlap. Deliberately broad on interrogatives and
// auxiliaries so a natural-language question can be a true paraphrase without
// tripping the check on unavoidable glue words.
export const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'of', 'to', 'in',
  'on', 'at', 'by', 'for', 'with', 'about', 'as', 'into', 'from', 'up', 'down',
  'out', 'over', 'under', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'am', 'do', 'does', 'did', 'doing', 'done', 'have', 'has', 'had', 'having',
  'can', 'could', 'should', 'would', 'will', 'shall', 'may', 'might', 'must',
  'i', 'me', 'my', 'we', 'us', 'our', 'you', 'your', 'he', 'she', 'it', 'its',
  'they', 'them', 'their', 'this', 'that', 'these', 'those', 'here', 'there',
  'what', 'which', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how',
  'all', 'any', 'each', 'every', 'some', 'no', 'not', 'only', 'own', 'same',
  'so', 'than', 'too', 'very', 'just', 'now', 'get', 'got', 'getting',
  'want', 'need', 'use', 'using', 'used', 'go', 'going', 'let', 'lets',
  'one', 'two', 'more', 'most', 'much', 'many', 'few', 'both', 'other',
  'again', 'also', 'ever', 'still', 'back', 'via', 'per', 'off', 'because',
  'while', 'during', 'before', 'after', 'between', 'through',
]);

export function contentTokens(text) {
  return tokenize(text).filter((token) => !STOPWORDS.has(token) && !/^\d+$/.test(token));
}

// Multiset of content-token overlap used only for the enforcement check.
export function contentTokenOverlap(a, b) {
  const setB = new Set(contentTokens(b));
  return contentTokens(a).filter((token) => setB.has(token));
}
