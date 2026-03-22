import { beforeEach, describe, expect, it } from 'vitest';

import { assessContext } from '../core/monitor.js';
import type { MemoryScope } from '../contracts/identity.js';
import type { Turn, WorkingMemory } from '../contracts/types.js';

const BASE_TIME = 1_742_498_400;
let nextId = 1;

function makeScope(): MemoryScope {
  return {
    tenant_id: 'acme',
    system_id: 'assistant',
    scope_id: 'thread-1',
  };
}

beforeEach(() => {
  nextId = 1;
});

function turnId(): number {
  return nextId++;
}

function makeTurn(
  content: string,
  role: Turn['role'] = 'user',
  options: { tokens?: number; createdAt?: number } = {},
): Turn {
  return {
    id: turnId(),
    session_id: 'session-1',
    tenant_id: 'acme',
    system_id: 'assistant',
    workspace_id: 'default',
    scope_id: 'thread-1',
    actor: role === 'user' ? 'user-1' : 'assistant-1',
    role,
    content,
    token_estimate:
      options.tokens ?? Math.max(1, Math.ceil((content.length / 4) * 1.15)),
    created_at: options.createdAt ?? BASE_TIME,
    archived_at: null,
    compaction_log_id: null,
    schema_version: 1,
  };
}

function makeThread(pairs: number, tokensPerTurn = 100): Turn[] {
  const turns: Turn[] = [];
  const content = 'x'.repeat(Math.max(1, Math.round((tokensPerTurn * 4) / 1.15)));
  for (let i = 0; i < pairs; i += 1) {
    turns.push(makeTurn(content, 'user', { createdAt: BASE_TIME + i * 30 }));
    turns.push(makeTurn(content, 'assistant', { createdAt: BASE_TIME + i * 30 + 10 }));
  }
  return turns;
}

function makeWorkingMemory(keyEntities: string[]): WorkingMemory {
  return {
    id: 1,
    session_id: 'session-1',
    tenant_id: 'acme',
    system_id: 'assistant',
    workspace_id: 'default',
    scope_id: 'thread-1',
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

function baseInput(turns: Turn[], workingMemory?: WorkingMemory | null) {
  return {
    scope: makeScope(),
    session_id: 'session-1',
    active_turns: turns,
    latest_working_memory: workingMemory ?? null,
    now: BASE_TIME + 60,
  };
}

describe('monitor floor conditions', () => {
  it('returns no compaction below the turn floor', () => {
    const turns = makeThread(5, 100);
    const report = assessContext(baseInput(turns));
    expect(report.below_floor).toBe(true);
    expect(report.recommendation.action).toBe('none');
    expect(report.floor_reason).toContain('Turn count');
  });

  it('returns no compaction below the token floor', () => {
    const turns: Turn[] = [];
    for (let i = 0; i < 8; i += 1) {
      turns.push(makeTurn('hi', 'user', { tokens: 5, createdAt: BASE_TIME + i * 30 }));
      turns.push(makeTurn('ok', 'assistant', { tokens: 5, createdAt: BASE_TIME + i * 30 + 10 }));
    }
    const report = assessContext(baseInput(turns));
    expect(report.below_floor).toBe(true);
    expect(report.floor_reason).toContain('Token estimate');
  });
});

describe('monitor recommendations', () => {
  it('returns a soft recommendation for a moderate unhealthy thread', () => {
    const turns = makeThread(10, 210);
    const report = assessContext(baseInput(turns));
    expect(report.below_floor).toBe(false);
    expect(report.recommendation.action).toBe('soft');
    expect(report.recommendation.defer_to_idle).toBe(true);
    expect(report.recommendation.post_compaction_target_turns).toBe(12);
  });

  it('returns a hard recommendation for a large unhealthy thread', () => {
    const turns = makeThread(18, 240);
    const report = assessContext(baseInput(turns));
    expect(report.recommendation.action).toBe('hard');
    expect(report.recommendation.defer_to_idle).toBe(false);
    expect(report.recommendation.post_compaction_target_turns).toBe(8);
    expect(report.score_breakdown.turn_count).toBe(4);
    expect(report.score_breakdown.token_estimate).toBe(4);
  });

  it('lets a heavy output spike push a borderline session to hard', () => {
    const turns = makeThread(10, 210);
    turns.push(makeTurn('x'.repeat(4800), 'assistant', { tokens: 1400 }));
    const report = assessContext(baseInput(turns));
    expect(report.recommendation.action).toBe('hard');
    expect(report.score_breakdown.tool_output).toBe(3);
  });
});

describe('topic drift detection', () => {
  it('detects an explicit subject change', () => {
    const turns = makeThread(10, 210);
    turns.push(makeTurn("Actually, let's switch to a different topic", 'user'));
    turns.push(makeTurn('Sure, what would you like?', 'assistant'));
    const signal = assessContext(baseInput(turns)).topic_drift_signals.find(
      (entry) => entry.type === 'explicit_subject_change',
    );
    expect(signal?.detected).toBe(true);
  });

  it('supports custom monitor patterns', () => {
    const turns = makeThread(10, 210);
    turns.push(makeTurn('Pivot to infra planning next.', 'user'));
    const signal = assessContext(baseInput(turns), {
      customPatterns: {
        subjectChange: [/\bpivot to\b/i],
      },
    }).topic_drift_signals.find((entry) => entry.type === 'explicit_subject_change');
    expect(signal?.detected).toBe(true);
  });

  it('detects entity discontinuity when recent turns do not overlap prior working memory', () => {
    const turns = makeThread(10, 210);
    const signal = assessContext(baseInput(turns, makeWorkingMemory(['Kubernetes', 'Docker']))).topic_drift_signals.find(
      (entry) => entry.type === 'entity_discontinuity',
    );
    expect(signal?.detected).toBe(true);
  });

  it('does not detect entity discontinuity for a fresh session', () => {
    const turns = makeThread(10, 210);
    const signal = assessContext(baseInput(turns, null)).topic_drift_signals.find(
      (entry) => entry.type === 'entity_discontinuity',
    );
    expect(signal?.detected).toBe(false);
  });

  it('requires at least two signals before drift is considered active', () => {
    const turns: Turn[] = [];
    for (let i = 0; i < 10; i += 1) {
      turns.push(
        makeTurn('Tell me about Kubernetes and Docker', 'user', {
          tokens: 200,
          createdAt: BASE_TIME + i * 30,
        }),
      );
      turns.push(
        makeTurn('Kubernetes orchestrates Docker containers', 'assistant', {
          tokens: 200,
          createdAt: BASE_TIME + i * 30 + 10,
        }),
      );
    }
    turns.push(
      makeTurn("Actually, let's talk about something else", 'user', {
        tokens: 200,
        createdAt: BASE_TIME + 310,
      }),
    );
    const report = assessContext(baseInput(turns, makeWorkingMemory(['Kubernetes', 'Docker'])));
    expect(report.topic_drift_signal_count).toBeLessThan(2);
    expect(report.topic_drift_detected).toBe(false);
  });
});

describe('completion and tool signals', () => {
  it('detects explicit acknowledgments', () => {
    const turns = makeThread(10, 210);
    turns.push(makeTurn("Thanks, that's exactly what I needed!", 'user'));
    expect(assessContext(baseInput(turns)).task_completion_detected).toBe(true);
  });

  it('detects deliverable followed by a gap', () => {
    const turns = makeThread(10, 210);
    turns.push(
      makeTurn('x'.repeat(400), 'assistant', {
        tokens: 150,
        createdAt: BASE_TIME,
      }),
    );
    const report = assessContext({
      ...baseInput(turns),
      now: BASE_TIME + 600,
    });
    const signal = report.task_completion_signals.find(
      (entry) => entry.type === 'deliverable_followed_by_gap',
    );
    expect(signal?.detected).toBe(true);
  });

  it('detects hard tool output spikes', () => {
    const turns = makeThread(10, 210);
    turns.push(makeTurn('huge output', 'assistant', { tokens: 1400 }));
    const report = assessContext(baseInput(turns));
    expect(report.tool_output_detected).toBe(true);
    expect(report.score_breakdown.tool_output).toBe(3);
  });
});

describe('report structure', () => {
  it('returns the normalized scope in the health report', () => {
    const report = assessContext(baseInput(makeThread(10, 210)));
    expect(report.scope.workspace_id).toBe('default');
    expect(report.scope.tenant_id).toBe('acme');
  });
});
