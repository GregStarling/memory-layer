import type { AsyncStorageAdapter } from '../contracts/async-storage.js';
import type { MemoryScope } from '../contracts/identity.js';
import type { MarkdownExportOptions, MarkdownExportResult } from '../contracts/export.js';
import { normalizeScope } from '../contracts/identity.js';
import type { KnowledgeMemory } from '../contracts/types.js';

function formatValidityWindow(km: KnowledgeMemory): string | null {
  const from = km.valid_from;
  const until = km.valid_until;
  if (from == null && until == null) return null;

  const formatDate = (epoch: number): string => new Date(epoch * 1000).toISOString().slice(0, 10);

  if (from != null && until != null) {
    return `valid: ${formatDate(from)} – ${formatDate(until)}`;
  }
  if (from != null) {
    return `valid from: ${formatDate(from)}`;
  }
  return `valid until: ${formatDate(until!)}`;
}

function sanitizeMarkdownUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  if (/^(?:javascript|data):/i.test(trimmed)) {
    return null;
  }
  try {
    return encodeURI(trimmed)
      .replaceAll('(', '%28')
      .replaceAll(')', '%29')
      .replaceAll('[', '%5B')
      .replaceAll(']', '%5D');
  } catch {
    return null;
  }
}

export async function exportAsMarkdown(
  adapter: AsyncStorageAdapter,
  scope: MemoryScope,
  options?: MarkdownExportOptions,
): Promise<MarkdownExportResult> {
  const opts: Required<MarkdownExportOptions> = {
    includeEvidence: options?.includeEvidence ?? false,
    includeTrustMetadata: options?.includeTrustMetadata ?? false,
    includeChangelog: options?.includeChangelog ?? false,
    changelogLimit: options?.changelogLimit ?? 50,
    groupBy: options?.groupBy ?? 'knowledge_class',
    filterByTags: options?.filterByTags ?? [],
    includeSourceDocuments: options?.includeSourceDocuments ?? false,
  };

  const normalizedScope = normalizeScope(scope);
  let allKnowledge = await adapter.getActiveKnowledgeMemory(scope);

  // Filter by tags when specified
  if (opts.filterByTags && opts.filterByTags.length > 0) {
    const tagSet = new Set(opts.filterByTags);
    allKnowledge = allKnowledge.filter((km) =>
      km.tags.some((tag) => tagSet.has(tag)),
    );
  }

  const files = new Map<string, string>();
  let totalAssociations = 0;

  // Try to count associations
  try {
    const associations = await adapter.listAssociations(scope);
    totalAssociations = associations.length;
  } catch {
    // associations may not be available
  }

  // Group knowledge
  const groups = new Map<string, KnowledgeMemory[]>();
  if (opts.groupBy === 'flat') {
    groups.set('all', allKnowledge);
  } else if (opts.groupBy === 'topic') {
    for (const km of allKnowledge) {
      const topic = km.fact_subject ?? 'general';
      const list = groups.get(topic) ?? [];
      list.push(km);
      groups.set(topic, list);
    }
  } else if (opts.groupBy === 'tag') {
    for (const km of allKnowledge) {
      if (km.tags.length === 0) {
        const list = groups.get('_untagged') ?? [];
        list.push(km);
        groups.set('_untagged', list);
      } else {
        for (const tag of km.tags) {
          // Sanitize tag for safe use as a filename/group key
          const safeTag = tag.replace(/[^a-zA-Z0-9_-]/g, '_') || '_empty';
          const list = groups.get(safeTag) ?? [];
          list.push(km);
          groups.set(safeTag, list);
        }
      }
    }
  } else {
    for (const km of allKnowledge) {
      const key = km.knowledge_class;
      const list = groups.get(key) ?? [];
      list.push(km);
      groups.set(key, list);
    }
  }

  // Count by state
  const stateCounts = new Map<string, number>();
  for (const km of allKnowledge) {
    stateCounts.set(km.knowledge_state, (stateCounts.get(km.knowledge_state) ?? 0) + 1);
  }

  // Count by class
  const classCounts = new Map<string, number>();
  for (const km of allKnowledge) {
    classCounts.set(km.knowledge_class, (classCounts.get(km.knowledge_class) ?? 0) + 1);
  }

  // Build index.md
  const indexLines: string[] = [];
  indexLines.push('# Knowledge Base');
  indexLines.push('');
  indexLines.push('## Summary');
  indexLines.push('');
  indexLines.push(`- **Total facts**: ${allKnowledge.length}`);
  indexLines.push(`- **Associations**: ${totalAssociations}`);
  indexLines.push('');

  if (stateCounts.size > 0) {
    indexLines.push('### By State');
    indexLines.push('');
    for (const [state, count] of [...stateCounts.entries()].sort()) {
      indexLines.push(`- ${state}: ${count}`);
    }
    indexLines.push('');
  }

  if (classCounts.size > 0) {
    indexLines.push('### By Class');
    indexLines.push('');
    for (const [cls, count] of [...classCounts.entries()].sort()) {
      indexLines.push(`- ${cls}: ${count}`);
    }
    indexLines.push('');
  }

  // Table of contents
  if (groups.size > 0) {
    indexLines.push('## Contents');
    indexLines.push('');
    for (const groupName of [...groups.keys()].sort()) {
      const fileName = `${groupName}.md`;
      indexLines.push(`- [${groupName}](${fileName})`);
    }
    indexLines.push('');
  }

  if (opts.includeChangelog) {
    indexLines.push(`- [changelog](changelog.md)`);
  }
  if (opts.includeSourceDocuments) {
    indexLines.push(`- [sources](sources.md)`);
  }

  files.set('index.md', indexLines.join('\n'));

  // Build per-group files
  for (const [groupName, items] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const lines: string[] = [];
    lines.push(`# ${groupName}`);
    lines.push('');

    for (const km of items) {
      let bullet = `- ${km.fact}`;
      const metaParts: string[] = [];
      if (opts.includeTrustMetadata) {
        metaParts.push(`trust: ${km.trust_score.toFixed(2)}`);
        metaParts.push(`state: ${km.knowledge_state}`);
        metaParts.push(`evidence: ${km.evidence_count}`);
      }
      const validityPart = formatValidityWindow(km);
      if (validityPart) {
        metaParts.push(validityPart);
      }
      if (metaParts.length > 0) {
        bullet += ` (${metaParts.join(', ')})`;
      }
      lines.push(bullet);

      if (opts.includeEvidence) {
        try {
          const evidence = await adapter.listKnowledgeEvidenceForKnowledge(km.id);
          for (const ev of evidence) {
            lines.push(`  - Evidence #${ev.id}: ${ev.source_type} (${ev.support_polarity})`);
          }
        } catch {
          // evidence listing may fail
        }
      }
    }

    lines.push('');
    files.set(`${groupName}.md`, lines.join('\n'));
  }

  // Build changelog.md
  if (opts.includeChangelog) {
    const lines: string[] = [];
    lines.push('# Changelog');
    lines.push('');

    try {
      const timeline = await adapter.listMemoryEvents(scope, {
        limit: opts.changelogLimit,
      });
      if (timeline.events.length === 0) {
        lines.push('No events recorded.');
      } else {
        for (const event of timeline.events) {
          const date = new Date(event.created_at * 1000).toISOString();
          lines.push(`- **${event.event_type}** on ${event.entity_kind}/${event.entity_id} — ${date}`);
        }
      }
    } catch {
      lines.push('Unable to retrieve events.');
    }

    lines.push('');
    files.set('changelog.md', lines.join('\n'));
  }

  // Build sources.md
  if (opts.includeSourceDocuments) {
    const lines: string[] = [];
    lines.push('# Source Documents');
    lines.push('');

    try {
      const result = await adapter.listSourceDocuments(scope, { limit: 100 });
      if (result.items.length === 0) {
        lines.push('No source documents.');
      } else {
        for (const doc of result.items) {
          const safeUrl = doc.url ? sanitizeMarkdownUrl(doc.url) : null;
          const urlPart = safeUrl ? ` — [link](${safeUrl})` : '';
          lines.push(`- **${doc.title}**${urlPart}`);
          lines.push(`  - Status: ${doc.status}, Facts: ${doc.fact_count}`);
        }
      }
    } catch {
      lines.push('Unable to retrieve source documents.');
    }

    lines.push('');
    files.set('sources.md', lines.join('\n'));
  }

  return {
    files,
    stats: {
      totalFacts: allKnowledge.length,
      totalFiles: files.size,
      totalAssociations,
    },
  };
}
