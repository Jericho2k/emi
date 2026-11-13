export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface Usage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface Citation {
  url: string;
  title: string;
}

/** Carries billed usage even when the provider never produced a usable answer. */
export class LlmResponseError extends Error {
  readonly kind: "unusable" | "request_failed" | "web_unavailable";
  constructor(message: string, public readonly usage: Usage, options?: ErrorOptions & { kind?: LlmResponseError["kind"] }) {
    super(message, options);
    this.kind = options?.kind ?? "unusable";
    this.name = "LlmResponseError";
  }
}

export interface ChatOptions {
  model: string;
  temperature?: number;
  maxTokens?: number;
  /** Ask the provider for a JSON object. */
  json?: boolean;
  /** Allow read-only web tools for this user-requested reply. */
  web?: boolean;
}

/** The whole model surface the core depends on. */
export interface Llm {
  readonly capabilities?: { web: boolean };
  chat(messages: ChatMessage[], options: ChatOptions): Promise<{ text: string; usage: Usage; citations?: Citation[] }>;
  embed(texts: string[], model: string): Promise<{ vectors: number[][]; usage: Usage }>;
}

export const EMBEDDING_DIMENSIONS = 1024;

/** Pulls the first JSON object out of a model reply, tolerating code fences. */
export function parseJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}
