/**
 * Provider-client contracts.
 *
 * The structured-generation client is the boundary type between core
 * orchestration (which asks for a structured completion) and the provider
 * summarizer/extractor implementations (which fulfil it against a concrete
 * LLM SDK). It lives in `contracts/` so core depends on the interface, not on
 * the `summarizers/` implementation layer.
 */

export interface StructuredGenerationRequest {
  systemPrompt: string;
  userPrompt: string;
  model?: string;
  maxTokens?: number;
  expectedFormat: 'object' | 'array';
}

export interface StructuredGenerationClient {
  generate(request: StructuredGenerationRequest): Promise<string>;
}
