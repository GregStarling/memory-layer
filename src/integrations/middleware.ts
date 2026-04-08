import type { MemoryManager } from '../core/manager.js';
import { formatContextForPrompt, type FormatOptions } from '../core/formatter.js';
import type { MemoryContext } from './../core/context.js';

export interface MessageLike {
  role: string;
  content: string;
}

export interface MessageHandler {
  (messages: MessageLike[]): Promise<string>;
}

export interface MemoryMiddlewareOptions {
  injectContext?: boolean;
  contextPosition?: 'system' | 'prepend';
  relevanceFromLastMessage?: boolean;
  /**
   * When true, the middleware captures the first `getContext` result and
   * reuses it for subsequent calls instead of rebuilding context on every
   * turn. Call the returned handler's `refreshSnapshot()` to invalidate.
   */
  snapshotMode?: boolean;
  /** Include provisional knowledge in context. */
  includeProvisionalKnowledge?: boolean;
  /** Include disputed knowledge in context. */
  includeDisputedKnowledge?: boolean;
  /** Format options for context rendering. */
  format?: FormatOptions;
  /** Include core memory bundle in context. */
  includeCoreMemory?: boolean;
  /** Include graph report summary in context. */
  includeGraphReport?: boolean;
  /** Tag filter for knowledge retrieval. */
  tags?: string[];
  /** Alias map override. */
  aliasMap?: import('../contracts/aliases.js').AliasMap;
}

export function wrapWithMemory(
  handler: MessageHandler,
  memory: MemoryManager,
  options: MemoryMiddlewareOptions = {},
): MessageHandler {
  let cachedContext: MemoryContext | null = null;

  return async (messages) => {
    const lastMessage = [...messages].reverse().find((message) => message.role === 'user') ?? messages.at(-1);
    if (!lastMessage) {
      return handler(messages);
    }

    await memory.processTurn('user', lastMessage.content, 'user');

    let nextMessages = messages;
    if (options.injectContext ?? true) {
      const query = (options.relevanceFromLastMessage ?? true) ? lastMessage.content : undefined;
      let context: MemoryContext;
      if (options.snapshotMode) {
        if (cachedContext == null) {
          cachedContext = await memory.getContext(query);
        }
        context = cachedContext;
      } else {
        context = await memory.getContext(query);
      }
      const formatOpts: FormatOptions = {
        includeCitations: true,
        ...options.format,
      };
      if (options.includeProvisionalKnowledge) formatOpts.includeProvisionalKnowledge = true;
      if (options.includeDisputedKnowledge) formatOpts.includeDisputedKnowledge = true;
      const memoryMessage = {
        role: 'system',
        content: formatContextForPrompt(context, formatOpts),
      };
      nextMessages =
        options.contextPosition === 'prepend'
          ? [memoryMessage, ...messages]
          : [...messages.filter((message) => message.role !== 'system'), memoryMessage];
    }

    const response = await handler(nextMessages);
    await memory.processTurn('assistant', response, 'assistant');
    return response;
  };
}
