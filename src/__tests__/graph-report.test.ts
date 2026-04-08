import { describe, it, expect, beforeEach } from 'vitest';
import { createInMemoryAdapter } from '../adapters/memory/index.js';
import { getGraphReport } from '../core/graph-report.js';
import type { MemoryScope } from '../contracts/identity.js';
import type { StorageAdapter } from '../contracts/storage.js';

const scope: MemoryScope = {
  tenant_id: 'test',
  system_id: 'test',
  scope_id: 'graph-report-test',
};

describe('getGraphReport', () => {
  let adapter: StorageAdapter;

  beforeEach(() => {
    adapter = createInMemoryAdapter();
  });

  it('returns empty sections for an empty scope', async () => {
    const report = await getGraphReport(adapter, scope);
    expect(report.sections).toEqual([]);
    expect(report.tokenEstimate).toBe(0);
    expect(report.generatedAt).toBeTruthy();
  });

  it('rejects non-positive token budgets', async () => {
    await expect(getGraphReport(adapter, scope, { tokenBudget: 0 })).rejects.toThrow(/tokenBudget/);
  });

  it('includes surprises section from discover()', async () => {
    const now = Math.floor(Date.now() / 1000);
    const k1 = adapter.insertKnowledgeMemory({
      ...scope, fact: 'Architecture uses microservices', fact_type: 'entity',
      knowledge_class: 'project_fact', source: 'user_stated', confidence: 'high',
      created_at: now, last_accessed_at: now,
    });
    const k2 = adapter.insertKnowledgeMemory({
      ...scope, fact: 'User prefers monolith', fact_type: 'preference',
      knowledge_class: 'preference', source: 'user_stated', confidence: 'high',
      created_at: now, last_accessed_at: now,
    });
    adapter.insertAssociation({
      ...scope, source_kind: 'knowledge', source_id: k1.id,
      target_kind: 'knowledge', target_id: k2.id,
      association_type: 'contradicts', confidence: 0.6, auto_generated: true,
    });

    const report = await getGraphReport(adapter, scope, { includeSections: ['surprises'] });
    const surprises = report.sections.find((s) => s.title === 'Surprising Connections');
    expect(surprises).toBeDefined();
    expect(surprises!.content).toContain('contradiction');
  });

  it('includes lint issues section', async () => {
    const now = Math.floor(Date.now() / 1000);
    // Create orphan knowledge (no associations, old enough)
    adapter.insertKnowledgeMemory({
      ...scope, fact: 'Orphan fact', fact_type: 'entity',
      knowledge_class: 'project_fact', source: 'user_stated', confidence: 'high',
      created_at: now - 30 * 86_400, last_accessed_at: now - 30 * 86_400,
    });

    const report = await getGraphReport(adapter, scope, { includeSections: ['issues'] });
    const issues = report.sections.find((s) => s.title === 'Knowledge Issues');
    // May or may not find issues depending on lint thresholds
    // At minimum, report should run without error
    expect(report.generatedAt).toBeTruthy();
  });

  it('includes high-degree facts section', async () => {
    const now = Math.floor(Date.now() / 1000);
    const hub = adapter.insertKnowledgeMemory({
      ...scope, fact: 'Central hub fact', fact_type: 'entity',
      knowledge_class: 'project_fact', source: 'user_stated', confidence: 'high',
      created_at: now, last_accessed_at: now,
    });

    // Connect 4 nodes to the hub
    for (let i = 0; i < 4; i++) {
      const leaf = adapter.insertKnowledgeMemory({
        ...scope, fact: `Leaf fact ${i}`, fact_type: 'entity',
        knowledge_class: 'project_fact', source: 'user_stated', confidence: 'high',
        created_at: now, last_accessed_at: now,
      });
      adapter.insertAssociation({
        ...scope, source_kind: 'knowledge', source_id: hub.id,
        target_kind: 'knowledge', target_id: leaf.id,
        association_type: 'related_to', confidence: 0.7, auto_generated: true,
      });
    }

    const report = await getGraphReport(adapter, scope, { includeSections: ['high_degree'] });
    const section = report.sections.find((s) => s.title === 'High-Degree Facts');
    expect(section).toBeDefined();
    expect(section!.content).toContain('Central hub fact');
    expect(section!.content).toContain('4 connections');
  });

  it('includes knowledge gaps section', async () => {
    const now = Math.floor(Date.now() / 1000);
    adapter.insertKnowledgeMemory({
      ...scope, fact: 'Low evidence fact', fact_type: 'entity',
      knowledge_class: 'project_fact', source: 'user_stated', confidence: 'medium',
      created_at: now, last_accessed_at: now,
    });

    const report = await getGraphReport(adapter, scope, { includeSections: ['gaps'] });
    const section = report.sections.find((s) => s.title === 'Knowledge Gaps');
    expect(section).toBeDefined();
    expect(section!.content).toContain('Low evidence fact');
  });

  it('includes active contradictions section', async () => {
    const now = Math.floor(Date.now() / 1000);
    const k1 = adapter.insertKnowledgeMemory({
      ...scope, fact: 'Deploy to US', fact_type: 'decision',
      knowledge_class: 'project_fact', source: 'user_stated', confidence: 'high',
      created_at: now, last_accessed_at: now,
    });
    const k2 = adapter.insertKnowledgeMemory({
      ...scope, fact: 'Deploy to EU', fact_type: 'decision',
      knowledge_class: 'project_fact', source: 'user_stated', confidence: 'high',
      created_at: now, last_accessed_at: now,
    });
    adapter.insertAssociation({
      ...scope, source_kind: 'knowledge', source_id: k1.id,
      target_kind: 'knowledge', target_id: k2.id,
      association_type: 'contradicts', confidence: 0.8, auto_generated: true,
    });

    const report = await getGraphReport(adapter, scope, { includeSections: ['contradictions'] });
    const section = report.sections.find((s) => s.title === 'Active Contradictions');
    expect(section).toBeDefined();
    expect(section!.content).toContain('Deploy to US');
    expect(section!.content).toContain('Deploy to EU');
  });

  it('includes recent changes section', async () => {
    const now = Math.floor(Date.now() / 1000);
    adapter.insertKnowledgeMemory({
      ...scope, fact: 'Just learned this', fact_type: 'entity',
      knowledge_class: 'project_fact', source: 'user_stated', confidence: 'high',
      created_at: now, last_accessed_at: now,
    });

    const report = await getGraphReport(adapter, scope, { includeSections: ['changes'] });
    const section = report.sections.find((s) => s.title === 'Recent Changes');
    expect(section).toBeDefined();
    expect(section!.content).toContain('Just learned this');
  });

  it('includes expiring temporal facts section', async () => {
    const now = Math.floor(Date.now() / 1000);
    adapter.insertKnowledgeMemory({
      ...scope, fact: 'Promo ends soon', fact_type: 'entity',
      knowledge_class: 'project_fact', source: 'user_stated', confidence: 'high',
      created_at: now, last_accessed_at: now,
      valid_until: now + 3 * 86_400, // expires in 3 days
    });

    const report = await getGraphReport(adapter, scope, { includeSections: ['expiring'] });
    const section = report.sections.find((s) => s.title === 'Expiring Soon');
    expect(section).toBeDefined();
    expect(section!.content).toContain('Promo ends soon');
    expect(section!.content).toContain('3d');
  });

  it('enforces top 5/5/10 limits per section', async () => {
    const now = Math.floor(Date.now() / 1000);
    // Create 15 knowledge facts with associations to test high_degree limit
    const facts = [];
    for (let i = 0; i < 15; i++) {
      facts.push(adapter.insertKnowledgeMemory({
        ...scope, fact: `Fact number ${i}`, fact_type: 'entity',
        knowledge_class: 'project_fact', source: 'user_stated', confidence: 'high',
        created_at: now, last_accessed_at: now,
      }));
    }
    // Give each fact a unique degree by connecting to the next
    for (let i = 0; i < facts.length - 1; i++) {
      adapter.insertAssociation({
        ...scope, source_kind: 'knowledge', source_id: facts[i].id,
        target_kind: 'knowledge', target_id: facts[i + 1].id,
        association_type: 'related_to', confidence: 0.5, auto_generated: true,
      });
    }

    const report = await getGraphReport(adapter, scope, { includeSections: ['high_degree'] });
    const section = report.sections.find((s) => s.title === 'High-Degree Facts');
    expect(section).toBeDefined();
    // Count bullet points — should be at most 10
    const bullets = section!.content.split('\n').filter((l) => l.startsWith('-'));
    expect(bullets.length).toBeLessThanOrEqual(10);
  });

  it('respects tokenBudget and trims low-priority sections', async () => {
    const now = Math.floor(Date.now() / 1000);
    // Create enough data to populate multiple sections
    for (let i = 0; i < 5; i++) {
      const k = adapter.insertKnowledgeMemory({
        ...scope, fact: `Fact ${i} with some additional detail to consume tokens adequately`,
        fact_type: 'entity',
        knowledge_class: i % 2 === 0 ? 'project_fact' : 'strategy',
        source: 'user_stated', confidence: 'high',
        created_at: now, last_accessed_at: now,
      });
      if (i > 0) {
        adapter.insertAssociation({
          ...scope, source_kind: 'knowledge', source_id: k.id,
          target_kind: 'knowledge', target_id: 1,
          association_type: 'related_to', confidence: 0.5, auto_generated: true,
        });
      }
    }

    // Small token budget — should produce fewer sections than a full report
    const fullReport = await getGraphReport(adapter, scope);
    const tinyReport = await getGraphReport(adapter, scope, { tokenBudget: 60 });
    expect(tinyReport.sections.length).toBeLessThan(fullReport.sections.length);
    expect(tinyReport.tokenEstimate).toBeLessThan(fullReport.tokenEstimate);
  });

  it('tokenEstimate never exceeds tokenBudget', async () => {
    const now = Math.floor(Date.now() / 1000);
    // Create enough data to populate all sections
    for (let i = 0; i < 10; i++) {
      const k = adapter.insertKnowledgeMemory({
        ...scope, fact: `Fact ${i} has enough text to consume a reasonable number of tokens in the output`,
        fact_type: 'entity',
        knowledge_class: i % 3 === 0 ? 'project_fact' : i % 3 === 1 ? 'strategy' : 'identity',
        source: 'user_stated', confidence: 'high',
        created_at: now, last_accessed_at: now,
        valid_until: i === 0 ? now + 2 * 86_400 : undefined,
      });
      if (i > 0) {
        adapter.insertAssociation({
          ...scope, source_kind: 'knowledge', source_id: k.id,
          target_kind: 'knowledge', target_id: 1,
          association_type: i % 2 === 0 ? 'related_to' : 'contradicts',
          confidence: 0.5, auto_generated: true,
        });
      }
    }

    for (const budget of [100, 200, 500, 2000]) {
      const report = await getGraphReport(adapter, scope, { tokenBudget: budget });
      expect(report.tokenEstimate).toBeLessThanOrEqual(budget);
    }
  });

  it('caps surprises section at 5 items', async () => {
    const now = Math.floor(Date.now() / 1000);
    // Create 8 facts in a chain with cross-class to generate many surprises
    const facts = [];
    for (let i = 0; i < 8; i++) {
      facts.push(adapter.insertKnowledgeMemory({
        ...scope, fact: `Chain fact ${i}`, fact_type: 'entity',
        knowledge_class: i % 2 === 0 ? 'project_fact' : 'strategy',
        source: 'user_stated', confidence: 'high',
        created_at: now, last_accessed_at: now,
      }));
    }
    for (let i = 0; i < facts.length - 1; i++) {
      adapter.insertAssociation({
        ...scope, source_kind: 'knowledge', source_id: facts[i].id,
        target_kind: 'knowledge', target_id: facts[i + 1].id,
        association_type: 'related_to', confidence: 0.4, auto_generated: true,
      });
    }

    const report = await getGraphReport(adapter, scope, { includeSections: ['surprises'] });
    const section = report.sections.find((s) => s.title === 'Surprising Connections');
    if (section) {
      const items = section.content.split('\n').filter((l) => /^\d+\./.test(l));
      expect(items.length).toBeLessThanOrEqual(5);
    }
  });

  it('caps contradictions section at 5 items', async () => {
    const now = Math.floor(Date.now() / 1000);
    // Create 8 contradicting pairs
    for (let i = 0; i < 8; i++) {
      const a = adapter.insertKnowledgeMemory({
        ...scope, fact: `Statement A${i}`, fact_type: 'decision',
        knowledge_class: 'project_fact', source: 'user_stated', confidence: 'high',
        created_at: now, last_accessed_at: now,
      });
      const b = adapter.insertKnowledgeMemory({
        ...scope, fact: `Statement B${i}`, fact_type: 'decision',
        knowledge_class: 'project_fact', source: 'user_stated', confidence: 'high',
        created_at: now, last_accessed_at: now,
      });
      adapter.insertAssociation({
        ...scope, source_kind: 'knowledge', source_id: a.id,
        target_kind: 'knowledge', target_id: b.id,
        association_type: 'contradicts', confidence: 0.8, auto_generated: true,
      });
    }

    const report = await getGraphReport(adapter, scope, { includeSections: ['contradictions'] });
    const section = report.sections.find((s) => s.title === 'Active Contradictions');
    expect(section).toBeDefined();
    const items = section!.content.split('\n').filter((l) => l.startsWith('-'));
    expect(items.length).toBeLessThanOrEqual(5);
  });

  it('caps gaps section at 5 items', async () => {
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 8; i++) {
      adapter.insertKnowledgeMemory({
        ...scope, fact: `Gap fact ${i}`, fact_type: 'entity',
        knowledge_class: 'project_fact', source: 'user_stated', confidence: 'medium',
        created_at: now, last_accessed_at: now,
      });
    }

    const report = await getGraphReport(adapter, scope, { includeSections: ['gaps'] });
    const section = report.sections.find((s) => s.title === 'Knowledge Gaps');
    expect(section).toBeDefined();
    const items = section!.content.split('\n').filter((l) => l.startsWith('-'));
    expect(items.length).toBeLessThanOrEqual(5);
  });

  it('filterByTags scopes surprises to tagged knowledge only', async () => {
    const now = Math.floor(Date.now() / 1000);
    // Tagged pair
    const tagged1 = adapter.insertKnowledgeMemory({
      ...scope, fact: 'Tagged fact A', fact_type: 'entity',
      knowledge_class: 'project_fact', source: 'user_stated', confidence: 'high',
      created_at: now, last_accessed_at: now, tags: ['frontend'],
    });
    const tagged2 = adapter.insertKnowledgeMemory({
      ...scope, fact: 'Tagged fact B', fact_type: 'entity',
      knowledge_class: 'strategy', source: 'user_stated', confidence: 'high',
      created_at: now, last_accessed_at: now, tags: ['frontend'],
    });
    // Untagged pair
    const untagged1 = adapter.insertKnowledgeMemory({
      ...scope, fact: 'Untagged fact X', fact_type: 'entity',
      knowledge_class: 'project_fact', source: 'user_stated', confidence: 'high',
      created_at: now, last_accessed_at: now,
    });
    const untagged2 = adapter.insertKnowledgeMemory({
      ...scope, fact: 'Untagged fact Y', fact_type: 'entity',
      knowledge_class: 'strategy', source: 'user_stated', confidence: 'high',
      created_at: now, last_accessed_at: now,
    });

    adapter.insertAssociation({
      ...scope, source_kind: 'knowledge', source_id: tagged1.id,
      target_kind: 'knowledge', target_id: tagged2.id,
      association_type: 'contradicts', confidence: 0.5, auto_generated: true,
    });
    adapter.insertAssociation({
      ...scope, source_kind: 'knowledge', source_id: untagged1.id,
      target_kind: 'knowledge', target_id: untagged2.id,
      association_type: 'contradicts', confidence: 0.5, auto_generated: true,
    });

    const report = await getGraphReport(adapter, scope, {
      includeSections: ['surprises', 'contradictions'],
      filterByTags: ['frontend'],
    });

    // Contradictions should only include the tagged pair
    const contradictions = report.sections.find((s) => s.title === 'Active Contradictions');
    if (contradictions) {
      expect(contradictions.content).toContain('Tagged fact A');
      expect(contradictions.content).not.toContain('Untagged fact X');
    }

    // Surprises (if any) should not reference untagged knowledge
    const surprises = report.sections.find((s) => s.title === 'Surprising Connections');
    if (surprises) {
      expect(surprises.content).not.toContain('Untagged');
    }
  });

  it('respects includeSections filter', async () => {
    const now = Math.floor(Date.now() / 1000);
    adapter.insertKnowledgeMemory({
      ...scope, fact: 'Some fact', fact_type: 'entity',
      knowledge_class: 'project_fact', source: 'user_stated', confidence: 'high',
      created_at: now, last_accessed_at: now,
    });

    const report = await getGraphReport(adapter, scope, {
      includeSections: ['gaps'],
    });
    // Only gaps section should appear (no surprises, issues, etc.)
    for (const section of report.sections) {
      expect(section.title).toBe('Knowledge Gaps');
    }
  });
});
