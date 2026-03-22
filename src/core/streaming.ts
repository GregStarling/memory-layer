import type { Turn, TurnRole } from '../contracts/types.js';
import type { MemoryManager } from './manager.js';

/**
 * A collector that accumulates streamed text chunks and commits them
 * as a single turn when finalized.
 */
export interface StreamCollector {
  /** Append a chunk of text to the buffer. */
  write(chunk: string): void;
  /** Get the current accumulated text. */
  getText(): string;
  /** Finalize the stream and commit the full content as a turn. */
  finalize(): Promise<Turn>;
}

/**
 * Creates a StreamCollector that buffers streamed model output and commits
 * the full response as a single turn when the stream ends.
 *
 * ```typescript
 * const collector = createStreamCollector(manager, 'assistant');
 * for await (const chunk of modelStream) {
 *   collector.write(chunk);
 * }
 * const turn = await collector.finalize();
 * ```
 */
export function createStreamCollector(
  manager: MemoryManager,
  role: TurnRole,
  actor?: string,
): StreamCollector {
  const chunks: string[] = [];
  let finalized = false;

  return {
    write(chunk: string) {
      if (finalized) {
        throw new Error('StreamCollector: cannot write after finalize()');
      }
      chunks.push(chunk);
    },

    getText() {
      return chunks.join('');
    },

    async finalize() {
      if (finalized) {
        throw new Error('StreamCollector: already finalized');
      }
      finalized = true;
      const content = chunks.join('');
      return manager.processTurn(role, content, actor);
    },
  };
}

/**
 * Processes an async iterable stream as a single turn.
 * Collects all chunks, then commits the full content.
 *
 * ```typescript
 * const turn = await processStreamingTurn(manager, 'assistant', modelStream);
 * ```
 */
export async function processStreamingTurn(
  manager: MemoryManager,
  role: TurnRole,
  stream: AsyncIterable<string>,
  actor?: string,
): Promise<Turn> {
  const collector = createStreamCollector(manager, role, actor);
  for await (const chunk of stream) {
    collector.write(chunk);
  }
  return collector.finalize();
}
