import { formatContextForPrompt } from '../core/formatter.js';
import type { MemoryManager } from '../core/manager.js';

export interface LangChainChatMessage {
  type: 'human' | 'ai' | 'system';
  content: string;
}

export interface LangChainMemoryVariables {
  history: string;
  context: string;
}

function toTurnRole(type: LangChainChatMessage['type']): 'user' | 'assistant' | 'system' {
  switch (type) {
    case 'human':
      return 'user';
    case 'ai':
      return 'assistant';
    default:
      return 'system';
  }
}

export function createLangChainMemoryBridge(memory: MemoryManager) {
  return {
    async loadMemoryVariables(values: { input?: string } = {}): Promise<LangChainMemoryVariables> {
      const context = await memory.getContext(values.input);
      const history = context.activeTurns
        .map((turn) => `${turn.role}: ${turn.content}`)
        .join('\n');
      return {
        history,
        context: formatContextForPrompt(context),
      };
    },

    async saveContext(
      input: { input?: string; user?: string },
      output: { output?: string; response?: string },
    ): Promise<void> {
      const userInput = input.input ?? input.user;
      const assistantOutput = output.output ?? output.response;
      if (!userInput || !assistantOutput) {
        return;
      }
      await memory.processExchange(userInput, assistantOutput);
    },

    async addMessages(messages: LangChainChatMessage[]): Promise<void> {
      for (const message of messages) {
        await memory.processTurn(toTurnRole(message.type), message.content);
      }
    },

    async clear(): Promise<void> {
      await memory.forceCompact();
      await memory.runMaintenance({
        workingMemoryTtlSeconds: 0,
        completedWorkItemTtlSeconds: 0,
        knowledgeStaleAfterSeconds: 0,
        consolidateKnowledge: true,
      });
    },
  };
}
