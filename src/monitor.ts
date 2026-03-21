// ---------------------------------------------------------------------------
// @nanoclaw/memory - Context Monitor (v1)
// ---------------------------------------------------------------------------
// Pure function. Reads Turn[] and optional WorkingMemory, returns a
// ContextHealthReport with compaction recommendation. No side effects.
// ---------------------------------------------------------------------------

import type { Turn, WorkingMemory } from './types.js';
import { estimateTokens } from './db.js';

// ---------------------------------------------------------------------------
// Thresholds (from approved compaction policy)
// ---------------------------------------------------------------------------

const SOFT_TURN = 15;
const HARD_TURN = 30;
const SOFT_TOKEN = 3000;
const HARD_TOKEN = 6000;
const SOFT_SCORE = 4;
const HARD_SCORE = 6;
const POST_COMPACTION_SOFT = 12;
const POST_COMPACTION_HARD = 8;
const RECENT_WINDOW = 10;
const TOOL_LOOK_BACK = 5;
const HEAVY_SINGLE_TOKEN_SOFT = 600;
const HEAVY_SINGLE_TOKEN_HARD = 1200;
const HEAVY_CUMULATIVE_TOKENS = 2400;
const INTRA_SESSION_GAP_SECONDS = 1800; // 30 minutes

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export type CompactionAction = 'none' | 'soft' | 'hard';

export type DriftSignalType =
  | 'explicit_subject_change'
  | 'entity_discontinuity'
  | 'unprompted_task_reset'
  | 'long_intra_session_gap';

export type CompletionSignalType =
  | 'explicit_acknowledgment'
  | 'deliverable_followed_by_gap'
  | 'explicit_close';

export type ToolOutputSignalType =
  | 'single_turn_spike'
  | 'single_turn_hard_spike'
  | 'cumulative_surge'
  | 'code_block';

export interface TopicDriftSignal {
  type: DriftSignalType;
  detected: boolean;
  turn_id: number | null;
  detail: string;
}

export interface TaskCompletionSignal {
  type: CompletionSignalType;
  detected: boolean;
  turn_id: number | null;
  detail: string;
}

export interface HeavyToolOutputSignal {
  type: ToolOutputSignalType;
  detected: boolean;
  turn_id: number | null;
  token_count: number;
}

export interface ScoreBreakdown {
  turn_count: number;
  token_estimate: number;
  topic_drift: number;
  task_completion: number;
  tool_output: number;
  total: number;
}

export interface CompactionRecommendation {
  action: CompactionAction;
  score: number;
  /** 0 if action is 'none', 12 for soft, 8 for hard. */
  post_compaction_target_turns: number;
  /** True for soft (wait for 60s idle window). False for hard (immediate). */
  defer_to_idle: boolean;
  reason: string;
}

export interface MonitorInput {
  channel: string;
  group_jid: string;
  session_id: string;
  active_turns: Turn[];
  /**
   * Most recent non-expired working memory for this (channel, group_jid).
   * When null/undefined: entity discontinuity is NOT DETECTED (fresh session rule).
   */
  latest_working_memory?: WorkingMemory | null;
  /**
   * Current unix timestamp in seconds.
   * Defaults to Date.now()/1000. Pass a fixed value for deterministic tests.
   */
  now?: number;
}

export interface ContextHealthReport {
  channel: string;
  group_jid: string;
  session_id: string;
  assessed_at: number;

  active_turn_count: number;
  /** Count of the last RECENT_WINDOW (10) turns. */
  recent_turn_count: number;

  active_token_estimate: number;
  recent_token_estimate: number;
  max_single_turn_tokens: number;
  avg_tokens_per_turn: number;

  /** Turns with token_estimate >= 600. */
  heavy_output_turn_count: number;
  heavy_output_token_sum: number;

  topic_drift_signals: TopicDriftSignal[];
  topic_drift_signal_count: number;
  /** True when >= 2 drift signals detected. */
  topic_drift_detected: boolean;

  task_completion_signals: TaskCompletionSignal[];
  task_completion_detected: boolean;

  tool_output_signals: HeavyToolOutputSignal[];
  tool_output_detected: boolean;

  score_breakdown: ScoreBreakdown;

  /** True if either floor condition fails (OR rule). Score is always 0 when true. */
  below_floor: boolean;
  floor_reason: string | null;

  recommendation: CompactionRecommendation;
}

// ---------------------------------------------------------------------------
// Drift signal detectors
// ---------------------------------------------------------------------------

const SUBJECT_CHANGE_PATTERNS = [
  /\bactually,?\s+(let'?s|can we|i want to)\b/i,
  /\bchanging? (topic|subject|gears)\b/i,
  /\bforget (that|about)\b/i,
  /\bnew topic\b/i,
  /\bswitching to\b/i,
  /\bmoving on\b/i,
  /\bdifferent question\b/i,
  /\bunrelated,? but\b/i,
  /\boff topic,? but\b/i,
  /\bsomething (else|different)\b/i,
];

function detectExplicitSubjectChange(turns: Turn[]): TopicDriftSignal {
  const recent = turns.slice(-RECENT_WINDOW);
  for (const t of recent) {
    if (t.role !== 'user') continue;
    for (const pattern of SUBJECT_CHANGE_PATTERNS) {
      if (pattern.test(t.content)) {
        return {
          type: 'explicit_subject_change',
          detected: true,
          turn_id: t.id,
          detail: `Matched: ${pattern.source}`,
        };
      }
    }
  }
  return {
    type: 'explicit_subject_change',
    detected: false,
    turn_id: null,
    detail: 'No explicit subject change detected',
  };
}

function detectEntityDiscontinuity(
  turns: Turn[],
  latestWm?: WorkingMemory | null,
): TopicDriftSignal {
  // Fresh session rule: no prior working memory => not detected
  if (!latestWm || latestWm.key_entities.length === 0) {
    return {
      type: 'entity_discontinuity',
      detected: false,
      turn_id: null,
      detail: 'No prior working memory or empty key_entities',
    };
  }

  const recentContent = turns
    .slice(-RECENT_WINDOW)
    .map((t) => t.content.toLowerCase())
    .join(' ');

  const wmWords = latestWm.key_entities.flatMap((e) =>
    e.toLowerCase().split(/\s+/),
  );

  const matchCount = wmWords.filter((w) => recentContent.includes(w)).length;
  const matchRatio = wmWords.length > 0 ? matchCount / wmWords.length : 1;

  // Less than 20% word overlap = entity discontinuity
  const detected = matchRatio < 0.2;
  return {
    type: 'entity_discontinuity',
    detected,
    turn_id: detected ? turns[turns.length - 1]?.id ?? null : null,
    detail: `Entity word overlap: ${Math.round(matchRatio * 100)}% (${matchCount}/${wmWords.length})`,
  };
}

const TASK_RESET_PATTERNS = [
  /\b(start|begin) (over|fresh|from scratch)\b/i,
  /\bscrap (that|this|it|everything)\b/i,
  /\blet'?s (try|do) something (else|new|different)\b/i,
  /\bnever\s?mind\b/i,
];

function detectUnpromptedTaskReset(turns: Turn[]): TopicDriftSignal {
  const recent = turns.slice(-RECENT_WINDOW);
  for (const t of recent) {
    if (t.role !== 'user') continue;
    for (const pattern of TASK_RESET_PATTERNS) {
      if (pattern.test(t.content)) {
        return {
          type: 'unprompted_task_reset',
          detected: true,
          turn_id: t.id,
          detail: `Matched: ${pattern.source}`,
        };
      }
    }
  }
  return {
    type: 'unprompted_task_reset',
    detected: false,
    turn_id: null,
    detail: 'No task reset detected',
  };
}

function detectLongIntraSessionGap(turns: Turn[]): TopicDriftSignal {
  if (turns.length < 2) {
    return {
      type: 'long_intra_session_gap',
      detected: false,
      turn_id: null,
      detail: 'Not enough turns to measure gap',
    };
  }
  for (let i = turns.length - 1; i > 0; i--) {
    const gap = turns[i].created_at - turns[i - 1].created_at;
    if (gap >= INTRA_SESSION_GAP_SECONDS) {
      return {
        type: 'long_intra_session_gap',
        detected: true,
        turn_id: turns[i].id,
        detail: `Gap of ${gap}s between turns ${turns[i - 1].id} and ${turns[i].id}`,
      };
    }
  }
  return {
    type: 'long_intra_session_gap',
    detected: false,
    turn_id: null,
    detail: 'No intra-session gap >= 30m',
  };
}

// ---------------------------------------------------------------------------
// Task completion detectors
// ---------------------------------------------------------------------------

const ACKNOWLEDGMENT_PATTERNS = [
  /\b(thanks?|thank you|perfect|great|got it|that'?s? (it|all|what i needed))\b/i,
  /\blooks? good\b/i,
  /\bawesome\b/i,
  /\bexactly\b/i,
];

function detectExplicitAcknowledgment(turns: Turn[]): TaskCompletionSignal {
  const recent = turns.slice(-5);
  for (let i = recent.length - 1; i >= 0; i--) {
    const t = recent[i];
    if (t.role !== 'user') continue;
    for (const pattern of ACKNOWLEDGMENT_PATTERNS) {
      if (pattern.test(t.content)) {
        return {
          type: 'explicit_acknowledgment',
          detected: true,
          turn_id: t.id,
          detail: `Matched: ${pattern.source}`,
        };
      }
    }
  }
  return {
    type: 'explicit_acknowledgment',
    detected: false,
    turn_id: null,
    detail: 'No acknowledgment detected',
  };
}

function detectDeliverableFollowedByGap(
  turns: Turn[],
  now: number,
): TaskCompletionSignal {
  if (turns.length < 2) {
    return {
      type: 'deliverable_followed_by_gap',
      detected: false,
      turn_id: null,
      detail: 'Not enough turns',
    };
  }
  const last = turns[turns.length - 1];
  // Last turn is assistant with substantial content, and time since > 5 min
  if (
    last.role === 'assistant' &&
    last.token_estimate >= 100 &&
    now - last.created_at >= 300
  ) {
    return {
      type: 'deliverable_followed_by_gap',
      detected: true,
      turn_id: last.id,
      detail: `Deliverable (${last.token_estimate} tokens) followed by ${now - last.created_at}s gap`,
    };
  }
  return {
    type: 'deliverable_followed_by_gap',
    detected: false,
    turn_id: null,
    detail: 'No deliverable-then-gap pattern',
  };
}

const CLOSE_PATTERNS = [
  /\b(bye|goodbye|see you|later|done|that'?s? all|signing off|good night|gn)\b/i,
];

function detectExplicitClose(turns: Turn[]): TaskCompletionSignal {
  const recent = turns.slice(-3);
  for (let i = recent.length - 1; i >= 0; i--) {
    const t = recent[i];
    if (t.role !== 'user') continue;
    for (const pattern of CLOSE_PATTERNS) {
      if (pattern.test(t.content)) {
        return {
          type: 'explicit_close',
          detected: true,
          turn_id: t.id,
          detail: `Matched: ${pattern.source}`,
        };
      }
    }
  }
  return {
    type: 'explicit_close',
    detected: false,
    turn_id: null,
    detail: 'No explicit close detected',
  };
}

// ---------------------------------------------------------------------------
// Tool output signal detection
// ---------------------------------------------------------------------------

function detectToolOutputSignals(turns: Turn[]): HeavyToolOutputSignal[] {
  const signals: HeavyToolOutputSignal[] = [];
  const window = turns.slice(-TOOL_LOOK_BACK);

  for (const t of window) {
    if (t.token_estimate >= HEAVY_SINGLE_TOKEN_HARD) {
      signals.push({
        type: 'single_turn_hard_spike',
        detected: true,
        turn_id: t.id,
        token_count: t.token_estimate,
      });
    } else if (t.token_estimate >= HEAVY_SINGLE_TOKEN_SOFT) {
      signals.push({
        type: 'single_turn_spike',
        detected: true,
        turn_id: t.id,
        token_count: t.token_estimate,
      });
    }
  }

  const cumulativeTokens = window.reduce((acc, t) => acc + t.token_estimate, 0);
  if (cumulativeTokens >= HEAVY_CUMULATIVE_TOKENS) {
    signals.push({
      type: 'cumulative_surge',
      detected: true,
      turn_id: window[window.length - 1]?.id ?? null,
      token_count: cumulativeTokens,
    });
  }

  return signals;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function computeScore(
  activeTurnCount: number,
  activeTokenEstimate: number,
  topicDriftDetected: boolean,
  taskCompletionDetected: boolean,
  turns: Turn[],
): ScoreBreakdown {
  const turnScore = activeTurnCount >= HARD_TURN ? 4 : 2;
  const tokenScore = activeTokenEstimate >= HARD_TOKEN ? 4 : 2;
  const driftScore = topicDriftDetected ? 2 : 0;
  const completionScore = taskCompletionDetected ? 1 : 0;

  // Tool output: if/elif per policy pseudocode (mutually exclusive tiers)
  const window = turns.slice(-TOOL_LOOK_BACK);
  const maxTurnTokens = window.reduce(
    (m, t) => Math.max(m, t.token_estimate),
    0,
  );
  const sumFiveTokens = window.reduce((acc, t) => acc + t.token_estimate, 0);
  let toolScore = 0;
  if (maxTurnTokens >= HEAVY_SINGLE_TOKEN_HARD) {
    toolScore = 3;
  } else if (
    maxTurnTokens >= HEAVY_SINGLE_TOKEN_SOFT ||
    sumFiveTokens >= HEAVY_CUMULATIVE_TOKENS
  ) {
    toolScore = 2;
  }

  const total =
    turnScore + tokenScore + driftScore + completionScore + toolScore;
  return {
    turn_count: turnScore,
    token_estimate: tokenScore,
    topic_drift: driftScore,
    task_completion: completionScore,
    tool_output: toolScore,
    total,
  };
}

function buildReason(prefix: string, score: ScoreBreakdown): string {
  const parts: string[] = [];
  if (score.turn_count > 0) parts.push(`turns:+${score.turn_count}`);
  if (score.token_estimate > 0) parts.push(`tokens:+${score.token_estimate}`);
  if (score.topic_drift > 0) parts.push(`drift:+${score.topic_drift}`);
  if (score.task_completion > 0)
    parts.push(`completion:+${score.task_completion}`);
  if (score.tool_output > 0) parts.push(`tool:+${score.tool_output}`);
  const detail = parts.length > 0 ? ` (${parts.join(', ')})` : '';
  return `${prefix}: score ${score.total}${detail}`;
}

function buildRecommendation(
  score: ScoreBreakdown,
  belowFloor: boolean,
  floorReason: string | null,
): CompactionRecommendation {
  if (belowFloor) {
    return {
      action: 'none',
      score: 0,
      post_compaction_target_turns: 0,
      defer_to_idle: false,
      reason: `No compaction: ${floorReason}`,
    };
  }
  if (score.total >= HARD_SCORE) {
    return {
      action: 'hard',
      score: score.total,
      post_compaction_target_turns: POST_COMPACTION_HARD,
      defer_to_idle: false,
      reason: buildReason('Hard trigger', score),
    };
  }
  if (score.total >= SOFT_SCORE) {
    return {
      action: 'soft',
      score: score.total,
      post_compaction_target_turns: POST_COMPACTION_SOFT,
      defer_to_idle: true,
      reason: buildReason('Soft trigger', score),
    };
  }
  return {
    action: 'none',
    score: score.total,
    post_compaction_target_turns: 0,
    defer_to_idle: false,
    reason: buildReason('Score below threshold', score),
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function assessContext(input: MonitorInput): ContextHealthReport {
  const {
    channel,
    group_jid,
    session_id,
    active_turns: turns,
    latest_working_memory,
  } = input;
  const now = input.now ?? Math.floor(Date.now() / 1000);

  const activeTurnCount = turns.length;
  const recentTurns = turns.slice(-RECENT_WINDOW);
  const activeTokenEstimate = turns.reduce(
    (acc, t) => acc + t.token_estimate,
    0,
  );
  const recentTokenEstimate = recentTurns.reduce(
    (acc, t) => acc + t.token_estimate,
    0,
  );
  const maxSingleTurnTokens = turns.reduce(
    (m, t) => Math.max(m, t.token_estimate),
    0,
  );
  const avgTokensPerTurn =
    activeTurnCount > 0
      ? Math.round(activeTokenEstimate / activeTurnCount)
      : 0;

  const heavyTurns = turns.filter(
    (t) => t.token_estimate >= HEAVY_SINGLE_TOKEN_SOFT,
  );

  const driftSignals: TopicDriftSignal[] = [
    detectExplicitSubjectChange(turns),
    detectEntityDiscontinuity(turns, latest_working_memory),
    detectUnpromptedTaskReset(turns),
    detectLongIntraSessionGap(turns),
  ];
  const topicDriftSignalCount = driftSignals.filter((s) => s.detected).length;
  const topicDriftDetected = topicDriftSignalCount >= 2;

  const completionSignals: TaskCompletionSignal[] = [
    detectExplicitAcknowledgment(turns),
    detectDeliverableFollowedByGap(turns, now),
    detectExplicitClose(turns),
  ];
  const taskCompletionDetected = completionSignals.some((s) => s.detected);

  const toolSignals = detectToolOutputSignals(turns);
  const toolOutputDetected = toolSignals.length > 0;

  // Floor check (OR rule)
  let belowFloor = false;
  let floorReason: string | null = null;
  if (activeTurnCount < SOFT_TURN) {
    belowFloor = true;
    floorReason = `Turn count (${activeTurnCount}) < floor (${SOFT_TURN})`;
  } else if (activeTokenEstimate < SOFT_TOKEN) {
    belowFloor = true;
    floorReason = `Token estimate (${activeTokenEstimate}) < floor (${SOFT_TOKEN})`;
  }

  const scoreBreakdown = computeScore(
    activeTurnCount,
    activeTokenEstimate,
    topicDriftDetected,
    taskCompletionDetected,
    turns,
  );
  const recommendation = buildRecommendation(
    scoreBreakdown,
    belowFloor,
    floorReason,
  );

  return {
    channel,
    group_jid,
    session_id,
    assessed_at: now,

    active_turn_count: activeTurnCount,
    recent_turn_count: recentTurns.length,

    active_token_estimate: activeTokenEstimate,
    recent_token_estimate: recentTokenEstimate,
    max_single_turn_tokens: maxSingleTurnTokens,
    avg_tokens_per_turn: avgTokensPerTurn,

    heavy_output_turn_count: heavyTurns.length,
    heavy_output_token_sum: heavyTurns.reduce(
      (acc, t) => acc + t.token_estimate,
      0,
    ),

    topic_drift_signals: driftSignals,
    topic_drift_signal_count: topicDriftSignalCount,
    topic_drift_detected: topicDriftDetected,

    task_completion_signals: completionSignals,
    task_completion_detected: taskCompletionDetected,

    tool_output_signals: toolSignals,
    tool_output_detected: toolOutputDetected,

    score_breakdown: scoreBreakdown,

    below_floor: belowFloor,
    floor_reason: floorReason,

    recommendation,
  };
}

// Re-export token estimator for callers that want consistent estimation
// without importing the DB module.
const tokenEst = estimateTokens;
export { tokenEst as estimateTokensLocal };
