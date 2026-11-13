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

export interface ChatOptions {
  model: string;
  temperature?: number;
  maxTokens?: number;
  /** Ask the provider for a JSON object. */
  json?: boolean;
}

/** The whole model surface the core depends on. */
export interface Llm {
  chat(messages: ChatMessage[], options: ChatOptions): Promise<{ text: string; usage: Usage }>;
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
