import { EMBEDDING_DIMENSIONS, type ChatMessage, type ChatOptions, type Llm, type Usage } from "./provider";

const BASE_URL = "https://openrouter.ai/api/v1";

function usageFrom(data: Record<string, unknown>, fallbackModel: string): Usage {
  const usage = (data.usage ?? {}) as Record<string, unknown>;
  return {
    model: typeof data.model === "string" ? data.model : fallbackModel,
    inputTokens: Number(usage.prompt_tokens) || 0,
    outputTokens: Number(usage.completion_tokens) || 0,
    costUsd: Number(usage.cost) || 0,
  };
}

async function post(apiKey: string, path: string, body: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
  let lastError: Error | null = null;
  // One retry, only for failures that a second attempt can plausibly fix.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(`${BASE_URL}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) return (await response.json()) as Record<string, unknown>;
      const detail = (await response.text()).slice(0, 300);
      lastError = new ProviderError(response.status, detail);
      if (response.status !== 429 && response.status < 500) break;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  throw lastError ?? new Error("request failed");
}

export class ProviderError extends Error {
  constructor(public status: number, detail: string) {
    super(`provider returned ${status}: ${detail}`);
  }
  /** The key itself is the problem, so the person has to act. */
  get isKeyProblem() {
    return this.status === 401 || this.status === 402 || this.status === 403;
  }
}

export function openRouter(apiKey: string): Llm {
  return {
    async chat(messages: ChatMessage[], options: ChatOptions) {
      const data = await post(apiKey, "/chat/completions", {
        model: options.model,
        messages,
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens ?? 1500,
        usage: { include: true },
        ...(options.json ? { response_format: { type: "json_object" } } : {}),
      }, 90_000);
      const choices = data.choices as Array<{ message?: { content?: unknown } }> | undefined;
      const content = choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) throw new Error("empty reply from model");
      return { text: content, usage: usageFrom(data, options.model) };
    },
    async embed(texts: string[], model: string) {
      if (!texts.length) return { vectors: [], usage: { model, inputTokens: 0, outputTokens: 0, costUsd: 0 } };
      const data = await post(apiKey, "/embeddings", {
        model, input: texts, dimensions: EMBEDDING_DIMENSIONS, encoding_format: "float",
      }, 30_000);
      const rows = (data.data ?? []) as Array<{ embedding?: unknown }>;
      const vectors = rows.map((row) => row.embedding).filter((v): v is number[] => Array.isArray(v) && v.length === EMBEDDING_DIMENSIONS);
      if (vectors.length !== texts.length) throw new Error("embedding count or size mismatch");
      return { vectors, usage: usageFrom(data, model) };
    },
  };
}
