import { describe, it, expect, beforeEach } from 'vitest';

import { assessContext } from './monitor.js';
import type { Turn, WorkingMemory } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_TIME = 1_742_498_400;
let _id = 1;

beforeEach(() => {
  _id = 1;
});

function tid(): number {
  return _id++;
}

function makeT(
  content: string,
  role: Turn['role'] = 'user',
  opts: { tokens?: number; createdAt?: number } = {},
): Turn {
  return {
    id: tid(),
    session_id: 'test-session',
    channel: 'telegram',
    group_jid: '-100111',
    sender: role === 'user' ? 'Greg' : 'assistant',
    role,
    content,
    token_estimate:
      opts.tokens ?? Math.max(1, Math.ceil((content.length / 4) * 1.15)),
    created_at: opts.createdAt ?? BASE_TIME,
    archived_at: null,
    compaction_log_id: null,
    schema_version: 1,
  };
}

/** Create n user+assistant pairs, each pair contributing approxTokensPerTurn tokens total. */
function makeThread(n: number, tokensPerTurn = 100): Turn[] {
  const turns: Turn[] = [];
  const content = 'x'.repeat(
    Math.max(1, Math.round((tokensPerTurn * 4) / 1.15)),
  );
  for (let i = 0; i < n; i++) {
    turns.push(makeT(content, 'user', { createdAt: BASE_TIME + i * 30 }));
    turns.push(
      makeT(content, 'assistant', { createdAt: BASE_TIME + i * 30 + 10 }),
    );
  }
  return turns;
}

function makeWM(keyEntities: string[]): WorkingMemory {
  return {
    id: 1,
    session_id: 'test-session',
    channel: 'telegram',
    group_jid: '-100111',
    summary: 'Prior session summary',
    key_entities: keyEntities,
    topic_tags: [],
    turn_id_start: 1,
    turn_id_end: 20,
    turn_count: 20,
    compaction_trigger: 'soft',
    created_at: BASE_TIME - 3600,
    expires_at: null,
    promoted_to_knowledge_id: null,
    schema_version: 1,
  };
}

function baseInput(turns: Turn[], wm?: WorkingMemory | null) {
  return {
    channel: 'telegram',
    group_jid: '-100111',
    session_id: 'test-session',
    active_turns: turns,
    latest_working_memory: wm ?? null,
    now: BASE_TIME + 60,
  };
}

// ---------------------------------------------------------------------------
// Floor checks
// ---------------------------------------------------------------------------

describe('floor conditions', () => {
  it('below floor: < 15 turns', () => {
    const turns = makeThread(5, 100); // 10 turns
    const report = assessContext(baseInput(turns));
    expect(report.below_floor).toBe(true);
    expect(report.recommendation.action).toBe('none');
    expect(report.floor_reason).toContain('Turn count');
  });

  it('below floor: >= 15 turns but < 3000 tokens', () => {
    // 16 turns, very short content => low tokens
    const turns: Turn[] = [];
    for (let i = 0; i < 8; i++) {
      turns.push(makeT('hi', 'user', { tokens: 5, createdAt: BASE_TIME + i * 30 }));
      turns.push(makeT('ok', 'assistant', { tokens: 5, createdAt: BASE_TIME + i * 30 + 10 }));
    }
    const report = assessContext(baseInput(turns));
    expect(report.below_floor).toBe(true);
    expect(report.floor_reason).toContain('Token estimate');
  });

  it('above floor: >= 15 turns AND >= 3000 tokens', () => {
    const turns = makeThread(10, 210); // 20 turns, ~4200 tokens
    const report = assessContext(baseInput(turns));
    expect(report.below_floor).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Healthy thread (below floor)
// ---------------------------------------------------------------------------

describe('healthy thread — no compaction needed', () => {
  it('short conversation returns no signals', () => {
    const turns = [
      makeT('Can you help me write a function?', 'user', { tokens: 12 }),
      makeT('Sure, here is a basic implementation.', 'assistant', {
        tokens: 18,
      }),
      makeT('Can you add error handling?', 'user', { tokens: 8 }),
      makeT('Done, added try/catch.', 'assistant', { tokens: 10 }),
    ];
    const report = assessContext(baseInput(turns));
    expect(report.below_floor).toBe(true);
    expect(report.recommendation.action).toBe('none');
    expect(report.topic_drift_detected).toBe(false);
    expect(report.task_completion_detected).toBe(false);
    expect(report.tool_output_detected).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Soft trigger
// ---------------------------------------------------------------------------

describe('unhealthy thread — soft trigger', () => {
  it('20 turns, moderate tokens -> soft compaction eligible', () => {
    const turns = makeThread(10, 210); // 20 turns, ~4200 tokens
    const report = assessContext(baseInput(turns));
    expect(report.below_floor).toBe(false);
    expect(report.recommendation.action).toBe('soft');
    expect(report.recommendation.defer_to_idle).toBe(true);
    expect(report.recommendation.post_compaction_target_turns).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// Hard trigger
// ---------------------------------------------------------------------------

describe('unhealthy thread — hard trigger', () => {
  it('35+ turns with high tokens -> immediate hard compaction', () => {
    const turns = makeThread(18, 240); // 36 turns, ~8640 tokens
    const report = assessContext(baseInput(turns));
    expect(report.below_floor).toBe(false);
    expect(report.recommendation.action).toBe('hard');
    expect(report.recommendation.defer_to_idle).toBe(false);
    expect(report.recommendation.post_compaction_target_turns).toBe(8);
    expect(report.score_breakdown.turn_count).toBe(4);
    expect(report.score_breakdown.token_estimate).toBe(4);
  });

  it('heavy tool output pushes borderline session to hard', () => {
    // 20 turns, 4200 tokens = score 4 (soft). One big paste tips it to hard.
    const turns = makeThread(10, 210);
    turns.push(makeT('x'.repeat(4800), 'assistant', { tokens: 1400 }));
    const report = assessContext(baseInput(turns));
    expect(report.recommendation.action).toBe('hard');
    expect(report.score_breakdown.tool_output).toBe(3);
    expect(report.recommendation.score).toBeGreaterThanOrEqual(6);
  });
});

// ---------------------------------------------------------------------------
// Topic drift signals
// ---------------------------------------------------------------------------

describe('topic drift detection', () => {
  it('explicit subject change detected', () => {
    const turns = makeThread(10, 210);
    turns.push(makeT('Actually, let\'s switch to a different topic', 'user'));
    turns.push(makeT('Sure, what would you like?', 'assistant'));
    const report = assessContext(baseInput(turns));
    const signal = report.topic_drift_signals.find(
      (s) => s.type === 'explicit_subject_change',
    );
    expect(signal?.detected).toBe(true);
  });

  it('entity discontinuity detected when prior WM entities absent', () => {
    const turns = makeThread(10, 210);
    // WM has entities that don't appear in recent turns
    const wm = makeWM(['Kubernetes', 'Docker', 'Terraform']);
    const report = assessContext(baseInput(turns, wm));
    const signal = report.topic_drift_signals.find(
      (s) => s.type === 'entity_discontinuity',
    );
    expect(signal?.detected).toBe(true);
  });

  it('entity discontinuity NOT detected with no prior WM (fresh session)', () => {
    const turns = makeThread(10, 210);
    const report = assessContext(baseInput(turns, null));
    const signal = report.topic_drift_signals.find(
      (s) => s.type === 'entity_discontinuity',
    );
    expect(signal?.detected).toBe(false);
  });

  it('entity discontinuity NOT detected when entities match', () => {
    // Build turns that contain the WM entities
    const turns: Turn[] = [];
    for (let i = 0; i < 10; i++) {
      turns.push(
        makeT('Tell me about Kubernetes and Docker deployment', 'user', {
          tokens: 200,
          createdAt: BASE_TIME + i * 30,
        }),
      );
      turns.push(
        makeT('Kubernetes orchestrates Docker containers via Terraform', 'assistant', {
          tokens: 200,
          createdAt: BASE_TIME + i * 30 + 10,
        }),
      );
    }
    const wm = makeWM(['Kubernetes', 'Docker', 'Terraform']);
    const report = assessContext(baseInput(turns, wm));
    const signal = report.topic_drift_signals.find(
      (s) => s.type === 'entity_discontinuity',
    );
    expect(signal?.detected).toBe(false);
  });

  it('long intra-session gap detected', () => {
    const turns = makeThread(10, 210);
    // Add a turn 45 minutes after the last one
    const lastTime = turns[turns.length - 1].created_at;
    turns.push(makeT('I\'m back', 'user', { tokens: 200, createdAt: lastTime + 2700 }));
    const report = assessContext(baseInput(turns));
    const signal = report.topic_drift_signals.find(
      (s) => s.type === 'long_intra_session_gap',
    );
    expect(signal?.detected).toBe(true);
  });

  it('topic drift requires >= 2 signals', () => {
    // Only one signal (explicit subject change) should not trigger drift
    const turns: Turn[] = [];
    for (let i = 0; i < 10; i++) {
      turns.push(
        makeT('Tell me about Kubernetes and Docker', 'user', {
          tokens: 200,
          createdAt: BASE_TIME + i * 30,
        }),
      );
      turns.push(
        makeT('Kubernetes orchestrates Docker containers', 'assistant', {
          tokens: 200,
          createdAt: BASE_TIME + i * 30 + 10,
        }),
      );
    }
    turns.push(makeT('Actually, let\'s talk about something else', 'user', {
      tokens: 200,
      createdAt: BASE_TIME + 310,
    }));
    const wm = makeWM(['Kubernetes', 'Docker']);
    const report = assessContext(baseInput(turns, wm));
    // Explicit subject change detected but entities still match => only 1 signal
    expect(report.topic_drift_signal_count).toBeLessThan(2);
    expect(report.topic_drift_detected).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Task completion signals
// ---------------------------------------------------------------------------

describe('task completion detection', () => {
  it('explicit acknowledgment detected', () => {
    const turns = makeThread(10, 210);
    turns.push(makeT('Thanks, that\'s exactly what I needed!', 'user'));
    const report = assessContext(baseInput(turns));
    expect(report.task_completion_detected).toBe(true);
  });

  it('deliverable followed by gap detected', () => {
    const turns = makeThread(10, 210);
    // Last turn is a big assistant output, and now is 10 min later
    turns.push(
      makeT('x'.repeat(400), 'assistant', {
        tokens: 150,
        createdAt: BASE_TIME,
      }),
    );
    const report = assessContext({
      ...baseInput(turns),
      now: BASE_TIME + 600, // 10 min later
    });
    const signal = report.task_completion_signals.find(
      (s) => s.type === 'deliverable_followed_by_gap',
    );
    expect(signal?.detected).toBe(true);
  });

  it('explicit close detected', () => {
    const turns = makeThread(10, 210);
    turns.push(makeT('Bye, see you later!', 'user'));
    const report = assessContext(baseInput(turns));
    const signal = report.task_completion_signals.find(
      (s) => s.type === 'explicit_close',
    );
    expect(signal?.detected).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tool output signals
// ---------------------------------------------------------------------------

describe('tool output detection', () => {
  it('single turn hard spike (>= 1200 tokens)', () => {
    const turns = makeThread(10, 210);
    turns.push(makeT('huge output', 'assistant', { tokens: 1400 }));
    const report = assessContext(baseInput(turns));
    expect(report.tool_output_detected).toBe(true);
    expect(report.score_breakdown.tool_output).toBe(3);
  });

  it('single turn soft spike (>= 600 tokens)', () => {
    const turns = makeThread(10, 210);
    turns.push(makeT('medium output', 'assistant', { tokens: 700 }));
    const report = assessContext(baseInput(turns));
    expect(report.tool_output_detected).toBe(true);
    expect(report.score_breakdown.tool_output).toBe(2);
  });

  it('no tool output signal for normal-sized turns', () => {
    const turns = makeThread(10, 210);
    const report = assessContext(baseInput(turns));
    expect(report.score_breakdown.tool_output).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Score breakdown
// ---------------------------------------------------------------------------

describe('score breakdown', () => {
  it('turn_count is 2 for soft range, 4 for hard range', () => {
    const softTurns = makeThread(10, 210); // 20 turns
    const hardTurns = makeThread(18, 240); // 36 turns
    expect(assessContext(baseInput(softTurns)).score_breakdown.turn_count).toBe(2);
    expect(assessContext(baseInput(hardTurns)).score_breakdown.turn_count).toBe(4);
  });

  it('token_estimate is 2 for soft range, 4 for hard range', () => {
    const softTurns = makeThread(10, 210); // ~4200 tokens
    const hardTurns = makeThread(18, 240); // ~8640 tokens
    expect(assessContext(baseInput(softTurns)).score_breakdown.token_estimate).toBe(2);
    expect(assessContext(baseInput(hardTurns)).score_breakdown.token_estimate).toBe(4);
  });

  it('drift score is 0 when below 2 signals', () => {
    const turns = makeThread(10, 210);
    const report = assessContext(baseInput(turns));
    expect(report.score_breakdown.topic_drift).toBe(0);
  });

  it('completion score is 1 when any completion signal fires', () => {
    const turns = makeThread(10, 210);
    turns.push(makeT('Thanks!', 'user'));
    const report = assessContext(baseInput(turns));
    expect(report.score_breakdown.task_completion).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Report structure
// ---------------------------------------------------------------------------

describe('report structure', () => {
  it('contains all required fields', () => {
    const turns = makeThread(10, 210);
    const report = assessContext(baseInput(turns));
    expect(report).toHaveProperty('channel');
    expect(report).toHaveProperty('group_jid');
    expect(report).toHaveProperty('session_id');
    expect(report).toHaveProperty('assessed_at');
    expect(report).toHaveProperty('active_turn_count');
    expect(report).toHaveProperty('recent_turn_count');
    expect(report).toHaveProperty('active_token_estimate');
    expect(report).toHaveProperty('recent_token_estimate');
    expect(report).toHaveProperty('max_single_turn_tokens');
    expect(report).toHaveProperty('avg_tokens_per_turn');
    expect(report).toHaveProperty('heavy_output_turn_count');
    expect(report).toHaveProperty('heavy_output_token_sum');
    expect(report).toHaveProperty('topic_drift_signals');
    expect(report).toHaveProperty('topic_drift_signal_count');
    expect(report).toHaveProperty('topic_drift_detected');
    expect(report).toHaveProperty('task_completion_signals');
    expect(report).toHaveProperty('task_completion_detected');
    expect(report).toHaveProperty('tool_output_signals');
    expect(report).toHaveProperty('tool_output_detected');
    expect(report).toHaveProperty('score_breakdown');
    expect(report).toHaveProperty('below_floor');
    expect(report).toHaveProperty('floor_reason');
    expect(report).toHaveProperty('recommendation');
  });

  it('recommendation contains all required fields', () => {
    const turns = makeThread(10, 210);
    const rec = assessContext(baseInput(turns)).recommendation;
    expect(rec).toHaveProperty('action');
    expect(rec).toHaveProperty('score');
    expect(rec).toHaveProperty('post_compaction_target_turns');
    expect(rec).toHaveProperty('defer_to_idle');
    expect(rec).toHaveProperty('reason');
  });
});
