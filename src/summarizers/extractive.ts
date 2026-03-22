import type { Turn } from '../contracts/types.js';
import { estimateTokens } from '../core/tokens.js';
import type { Summarizer, SummarizerOutput } from '../core/orchestrator.js';

const KEYWORD_HINTS = [
  'prefer',
  'preference',
  'decide',
  'decision',
  'must',
  'should',
  'cannot',
  'require',
  'constraint',
  'remember',
  'important',
  'goal',
  'objective',
  'blocker',
];

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'for',
  'from',
  'has',
  'have',
  'i',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'that',
  'the',
  'their',
  'this',
  'to',
  'was',
  'we',
  'with',
  'you',
]);

interface ScoredSentence {
  text: string;
  score: number;
  originalIndex: number;
}

function splitSentences(content: string): string[] {
  return content
    .split(/(?<=[.!?])\s+|\n+/g)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9@#'-]+/g)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function jaccardOverlap(a: string, b: string): number {
  const left = new Set(tokenize(a));
  const right = new Set(tokenize(b));
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  return intersection / (left.size + right.size - intersection);
}

function keywordDensity(sentence: string): number {
  const lowered = sentence.toLowerCase();
  let density = 0;
  for (const keyword of KEYWORD_HINTS) {
    if (lowered.includes(keyword)) {
      density += 1;
    }
  }
  return density;
}

function extractQuotedStrings(text: string): string[] {
  return [...text.matchAll(/"([^"]+)"|'([^']+)'/g)]
    .map((match) => (match[1] ?? match[2] ?? '').trim())
    .filter(Boolean);
}

function extractMentions(text: string): string[] {
  return [...text.matchAll(/@\w[\w/-]*/g)].map((match) => match[0]);
}

function extractCapitalizedPhrases(text: string): string[] {
  return [...text.matchAll(/\b[A-Z][a-z0-9]+(?:\s+[A-Z][a-z0-9]+)+\b/g)].map((match) => match[0]);
}

function uniqueValues(values: string[], limit: number): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    results.push(value.trim());
    if (results.length >= limit) break;
  }
  return results;
}

function buildTopicTags(turns: Turn[]): string[] {
  const counts = new Map<string, number>();
  for (const turn of turns) {
    for (const token of tokenize(turn.content)) {
      if (token.startsWith('@') || token.length < 4) continue;
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([token]) => token);
}

function buildKeyEntities(turns: Turn[]): string[] {
  const values = turns.flatMap((turn) => [
    ...extractCapitalizedPhrases(turn.content),
    ...extractQuotedStrings(turn.content),
    ...extractMentions(turn.content),
  ]);
  return uniqueValues(values, 10);
}

export function createExtractiveSummarizer(
  options?: { tokenBudget?: number; maxSentences?: number },
): Summarizer {
  const tokenBudget = options?.tokenBudget ?? 500;
  const maxSentences = options?.maxSentences ?? 6;

  return async (turns): Promise<SummarizerOutput> => {
    if (turns.length === 0) {
      return {
        summary: 'No conversation history yet.',
        key_entities: [],
        topic_tags: [],
      };
    }

    const scored: ScoredSentence[] = [];
    let sentenceIndex = 0;

    for (const turn of turns) {
      const sentences = splitSentences(turn.content);
      sentences.forEach((sentence, index) => {
        const tokens = tokenize(sentence);
        const positionWeight = index === 0 || index === sentences.length - 1 ? 1.5 : 1;
        const uniquenessPenalty = scored.some((existing) => jaccardOverlap(existing.text, sentence) > 0.7)
          ? 0.35
          : 1;
        const score =
          positionWeight * uniquenessPenalty * (1 + keywordDensity(sentence) + tokens.length / 20);
        scored.push({
          text: sentence,
          score,
          originalIndex: sentenceIndex,
        });
        sentenceIndex += 1;
      });
    }

    const selected = scored
      .sort((a, b) => b.score - a.score || a.originalIndex - b.originalIndex)
      .reduce<{ items: ScoredSentence[]; tokens: number }>(
        (state, candidate) => {
          if (state.items.length >= maxSentences) return state;
          const tokenEstimate = estimateTokens(candidate.text);
          if (state.tokens + tokenEstimate > tokenBudget && state.items.length > 0) {
            return state;
          }
          state.items.push(candidate);
          state.tokens += tokenEstimate;
          return state;
        },
        { items: [], tokens: 0 },
      )
      .items
      .sort((a, b) => a.originalIndex - b.originalIndex);

    const summary =
      selected.map((item) => item.text).join(' ') ||
      turns
        .map((turn) => turn.content.trim())
        .filter(Boolean)
        .join(' ')
        .slice(0, 400);

    return {
      summary,
      key_entities: buildKeyEntities(turns),
      topic_tags: buildTopicTags(turns),
    };
  };
}
