import type { MemoryScope, NormalizedMemoryScope } from '../contracts/identity.js';
import { normalizeScope } from '../contracts/identity.js';
import type { MonitorPatterns, MonitorPolicy } from '../contracts/policy.js';
import { DEFAULT_MONITOR_POLICY } from '../contracts/policy.js';
import type { Turn, WorkingMemory } from '../contracts/types.js';

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
  post_compaction_target_turns: number;
  defer_to_idle: boolean;
  reason: string;
}

export interface MonitorInput {
  scope: MemoryScope;
  session_id: string;
  active_turns: Turn[];
  latest_working_memory?: WorkingMemory | null;
  now?: number;
}

export interface ContextHealthReport {
  scope: NormalizedMemoryScope;
  session_id: string;
  assessed_at: number;
  active_turn_count: number;
  recent_turn_count: number;
  active_token_estimate: number;
  recent_token_estimate: number;
  max_single_turn_tokens: number;
  avg_tokens_per_turn: number;
  heavy_output_turn_count: number;
  heavy_output_token_sum: number;
  topic_drift_signals: TopicDriftSignal[];
  topic_drift_signal_count: number;
  topic_drift_detected: boolean;
  task_completion_signals: TaskCompletionSignal[];
  task_completion_detected: boolean;
  tool_output_signals: HeavyToolOutputSignal[];
  tool_output_detected: boolean;
  score_breakdown: ScoreBreakdown;
  below_floor: boolean;
  floor_reason: string | null;
  recommendation: CompactionRecommendation;
}

const DEFAULT_SUBJECT_CHANGE_PATTERNS = [
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
const DEFAULT_TASK_RESET_PATTERNS = [
  /\b(start|begin) (over|fresh|from scratch)\b/i,
  /\bscrap (that|this|it|everything)\b/i,
  /\blet'?s (try|do) something (else|new|different)\b/i,
  /\bnever\s?mind\b/i,
];
const DEFAULT_ACKNOWLEDGMENT_PATTERNS = [
  /\b(thanks?|thank you|perfect|great|got it|that'?s? (it|all|what i needed))\b/i,
  /\blooks? good\b/i,
  /\bawesome\b/i,
  /\bexactly\b/i,
];
const DEFAULT_CLOSE_PATTERNS = [
  /\b(bye|goodbye|see you|later|done|that'?s? all|signing off|good night|gn)\b/i,
];

function resolvePolicy(policy?: MonitorPolicy): Required<Omit<MonitorPolicy, 'customPatterns'>> & {
  customPatterns: Partial<MonitorPatterns>;
} {
  return {
    ...DEFAULT_MONITOR_POLICY,
    ...policy,
    customPatterns: {
      ...DEFAULT_MONITOR_POLICY.customPatterns,
      ...policy?.customPatterns,
    },
  };
}

function resolvePatterns(
  policy: ReturnType<typeof resolvePolicy>,
): Required<MonitorPatterns> {
  return {
    subjectChange: [...DEFAULT_SUBJECT_CHANGE_PATTERNS, ...(policy.customPatterns.subjectChange ?? [])],
    taskReset: [...DEFAULT_TASK_RESET_PATTERNS, ...(policy.customPatterns.taskReset ?? [])],
    acknowledgment: [
      ...DEFAULT_ACKNOWLEDGMENT_PATTERNS,
      ...(policy.customPatterns.acknowledgment ?? []),
    ],
    close: [...DEFAULT_CLOSE_PATTERNS, ...(policy.customPatterns.close ?? [])],
  };
}

function detectExplicitSubjectChange(
  turns: Turn[],
  recentWindow: number,
  patterns: RegExp[],
): TopicDriftSignal {
  const recent = turns.slice(-recentWindow);
  for (const turn of recent) {
    if (turn.role !== 'user') continue;
    for (const pattern of patterns) {
      if (pattern.test(turn.content)) {
        return {
          type: 'explicit_subject_change',
          detected: true,
          turn_id: turn.id,
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
  latestWorkingMemory?: WorkingMemory | null,
  recentWindow = DEFAULT_MONITOR_POLICY.recentWindow,
): TopicDriftSignal {
  if (!latestWorkingMemory || latestWorkingMemory.key_entities.length === 0) {
    return {
      type: 'entity_discontinuity',
      detected: false,
      turn_id: null,
      detail: 'No prior working memory or empty key_entities',
    };
  }

  const recentContent = turns
    .slice(-recentWindow)
    .map((turn) => turn.content.toLowerCase())
    .join(' ');

  const entityWords = latestWorkingMemory.key_entities.flatMap((entity) =>
    entity.toLowerCase().split(/\s+/),
  );
  const matchCount = entityWords.filter((word) => recentContent.includes(word)).length;
  const matchRatio = entityWords.length > 0 ? matchCount / entityWords.length : 1;
  const detected = matchRatio < 0.2;

  return {
    type: 'entity_discontinuity',
    detected,
    turn_id: detected ? turns[turns.length - 1]?.id ?? null : null,
    detail: `Entity word overlap: ${Math.round(matchRatio * 100)}% (${matchCount}/${entityWords.length})`,
  };
}

function detectUnpromptedTaskReset(
  turns: Turn[],
  recentWindow: number,
  patterns: RegExp[],
): TopicDriftSignal {
  const recent = turns.slice(-recentWindow);
  for (const turn of recent) {
    if (turn.role !== 'user') continue;
    for (const pattern of patterns) {
      if (pattern.test(turn.content)) {
        return {
          type: 'unprompted_task_reset',
          detected: true,
          turn_id: turn.id,
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

function detectLongIntraSessionGap(
  turns: Turn[],
  intraSessionGapSeconds: number,
): TopicDriftSignal {
  if (turns.length < 2) {
    return {
      type: 'long_intra_session_gap',
      detected: false,
      turn_id: null,
      detail: 'Not enough turns to measure gap',
    };
  }

  for (let i = turns.length - 1; i > 0; i -= 1) {
    const gap = turns[i].created_at - turns[i - 1].created_at;
    if (gap >= intraSessionGapSeconds) {
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

function detectExplicitAcknowledgment(
  turns: Turn[],
  patterns: RegExp[],
): TaskCompletionSignal {
  const recent = turns.slice(-5);
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const turn = recent[i];
    if (turn.role !== 'user') continue;
    for (const pattern of patterns) {
      if (pattern.test(turn.content)) {
        return {
          type: 'explicit_acknowledgment',
          detected: true,
          turn_id: turn.id,
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

function detectDeliverableFollowedByGap(turns: Turn[], now: number): TaskCompletionSignal {
  if (turns.length < 2) {
    return {
      type: 'deliverable_followed_by_gap',
      detected: false,
      turn_id: null,
      detail: 'Not enough turns',
    };
  }

  const last = turns[turns.length - 1];
  if (last.role === 'assistant' && last.token_estimate >= 100 && now - last.created_at >= 300) {
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

function detectExplicitClose(
  turns: Turn[],
  patterns: RegExp[],
): TaskCompletionSignal {
  const recent = turns.slice(-3);
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const turn = recent[i];
    if (turn.role !== 'user') continue;
    for (const pattern of patterns) {
      if (pattern.test(turn.content)) {
        return {
          type: 'explicit_close',
          detected: true,
          turn_id: turn.id,
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

function detectToolOutputSignals(
  turns: Turn[],
  toolLookBack: number,
  heavySingleTokenSoft: number,
  heavySingleTokenHard: number,
  heavyCumulativeTokens: number,
): HeavyToolOutputSignal[] {
  const signals: HeavyToolOutputSignal[] = [];
  const window = turns.slice(-toolLookBack);

  for (const turn of window) {
    if (turn.token_estimate >= heavySingleTokenHard) {
      signals.push({
        type: 'single_turn_hard_spike',
        detected: true,
        turn_id: turn.id,
        token_count: turn.token_estimate,
      });
    } else if (turn.token_estimate >= heavySingleTokenSoft) {
      signals.push({
        type: 'single_turn_spike',
        detected: true,
        turn_id: turn.id,
        token_count: turn.token_estimate,
      });
    }
  }

  const cumulativeTokens = window.reduce((acc, turn) => acc + turn.token_estimate, 0);
  if (cumulativeTokens >= heavyCumulativeTokens) {
    signals.push({
      type: 'cumulative_surge',
      detected: true,
      turn_id: window[window.length - 1]?.id ?? null,
      token_count: cumulativeTokens,
    });
  }

  return signals;
}

function computeScore(
  activeTurnCount: number,
  activeTokenEstimate: number,
  topicDriftDetected: boolean,
  taskCompletionDetected: boolean,
  turns: Turn[],
  policy: Required<MonitorPolicy>,
): ScoreBreakdown {
  const turnScore = activeTurnCount >= policy.hardTurnThreshold ? 4 : 2;
  const tokenScore = activeTokenEstimate >= policy.hardTokenThreshold ? 4 : 2;
  const driftScore = topicDriftDetected ? 2 : 0;
  const completionScore = taskCompletionDetected ? 1 : 0;

  const window = turns.slice(-policy.toolLookBack);
  const maxTurnTokens = window.reduce((max, turn) => Math.max(max, turn.token_estimate), 0);
  const sumFiveTokens = window.reduce((acc, turn) => acc + turn.token_estimate, 0);

  let toolScore = 0;
  if (maxTurnTokens >= policy.heavySingleTokenHard) {
    toolScore = 3;
  } else if (
    maxTurnTokens >= policy.heavySingleTokenSoft ||
    sumFiveTokens >= policy.heavyCumulativeTokens
  ) {
    toolScore = 2;
  }

  return {
    turn_count: turnScore,
    token_estimate: tokenScore,
    topic_drift: driftScore,
    task_completion: completionScore,
    tool_output: toolScore,
    total: turnScore + tokenScore + driftScore + completionScore + toolScore,
  };
}

function buildReason(prefix: string, score: ScoreBreakdown): string {
  const parts: string[] = [];
  if (score.turn_count > 0) parts.push(`turns:+${score.turn_count}`);
  if (score.token_estimate > 0) parts.push(`tokens:+${score.token_estimate}`);
  if (score.topic_drift > 0) parts.push(`drift:+${score.topic_drift}`);
  if (score.task_completion > 0) parts.push(`completion:+${score.task_completion}`);
  if (score.tool_output > 0) parts.push(`tool:+${score.tool_output}`);
  const detail = parts.length > 0 ? ` (${parts.join(', ')})` : '';
  return `${prefix}: score ${score.total}${detail}`;
}

function buildRecommendation(
  score: ScoreBreakdown,
  belowFloor: boolean,
  floorReason: string | null,
  policy: Required<MonitorPolicy>,
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
  if (score.total >= policy.hardScoreThreshold) {
    return {
      action: 'hard',
      score: score.total,
      post_compaction_target_turns: policy.hardRetainTurns,
      defer_to_idle: false,
      reason: buildReason('Hard trigger', score),
    };
  }
  if (score.total >= policy.softScoreThreshold) {
    return {
      action: 'soft',
      score: score.total,
      post_compaction_target_turns: policy.softRetainTurns,
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

export function assessContext(
  input: MonitorInput,
  policyOverrides?: MonitorPolicy,
): ContextHealthReport {
  const policy = resolvePolicy(policyOverrides);
  const scope = normalizeScope(input.scope);
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const turns = input.active_turns;
  const activeTurnCount = turns.length;
  const recentTurns = turns.slice(-policy.recentWindow);
  const patterns = resolvePatterns(policy);
  const activeTokenEstimate = turns.reduce((acc, turn) => acc + turn.token_estimate, 0);
  const recentTokenEstimate = recentTurns.reduce((acc, turn) => acc + turn.token_estimate, 0);
  const maxSingleTurnTokens = turns.reduce((max, turn) => Math.max(max, turn.token_estimate), 0);
  const avgTokensPerTurn = activeTurnCount > 0 ? Math.round(activeTokenEstimate / activeTurnCount) : 0;
  const heavyTurns = turns.filter(
    (turn) => turn.token_estimate >= policy.heavySingleTokenSoft,
  );

  const driftSignals: TopicDriftSignal[] = [
    detectExplicitSubjectChange(turns, policy.recentWindow, patterns.subjectChange),
    detectEntityDiscontinuity(turns, input.latest_working_memory, policy.recentWindow),
    detectUnpromptedTaskReset(turns, policy.recentWindow, patterns.taskReset),
    detectLongIntraSessionGap(turns, policy.intraSessionGapSeconds),
  ];
  const topicDriftSignalCount = driftSignals.filter((signal) => signal.detected).length;
  const topicDriftDetected = topicDriftSignalCount >= 2;

  const completionSignals: TaskCompletionSignal[] = [
    detectExplicitAcknowledgment(turns, patterns.acknowledgment),
    detectDeliverableFollowedByGap(turns, now),
    detectExplicitClose(turns, patterns.close),
  ];
  const taskCompletionDetected = completionSignals.some((signal) => signal.detected);

  const toolSignals = detectToolOutputSignals(
    turns,
    policy.toolLookBack,
    policy.heavySingleTokenSoft,
    policy.heavySingleTokenHard,
    policy.heavyCumulativeTokens,
  );
  const toolOutputDetected = toolSignals.length > 0;

  let belowFloor = false;
  let floorReason: string | null = null;
  if (activeTurnCount < policy.floorTurns) {
    belowFloor = true;
    floorReason = `Turn count (${activeTurnCount}) < floor (${policy.floorTurns})`;
  } else if (activeTokenEstimate < policy.floorTokens) {
    belowFloor = true;
    floorReason = `Token estimate (${activeTokenEstimate}) < floor (${policy.floorTokens})`;
  }

  const scoreBreakdown = computeScore(
    activeTurnCount,
    activeTokenEstimate,
    topicDriftDetected,
    taskCompletionDetected,
    turns,
    policy,
  );
  const recommendation = buildRecommendation(
    scoreBreakdown,
    belowFloor,
    floorReason,
    policy,
  );

  return {
    scope,
    session_id: input.session_id,
    assessed_at: now,
    active_turn_count: activeTurnCount,
    recent_turn_count: recentTurns.length,
    active_token_estimate: activeTokenEstimate,
    recent_token_estimate: recentTokenEstimate,
    max_single_turn_tokens: maxSingleTurnTokens,
    avg_tokens_per_turn: avgTokensPerTurn,
    heavy_output_turn_count: heavyTurns.length,
    heavy_output_token_sum: heavyTurns.reduce((acc, turn) => acc + turn.token_estimate, 0),
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
