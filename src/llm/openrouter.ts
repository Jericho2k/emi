import { EMBEDDING_DIMENSIONS, LlmResponseError, parseJsonObject, type ChatMessage, type ChatOptions, type Citation, type Llm, type Usage } from "./provider";

const BASE_URL = "https://openrouter.ai/api/v1";
const row = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const number = (value: unknown): number => Math.max(0, Number(value) || 0);

function usageFrom(data: Record<string, unknown>, fallbackModel: string): Usage {
  const usage = row(data.usage);
  return {
    model: typeof data.model === "string" ? data.model : fallbackModel,
    inputTokens: number(usage.prompt_tokens ?? usage.input_tokens),
    outputTokens: number(usage.completion_tokens ?? usage.output_tokens),
    costUsd: number(usage.cost),
  };
}

function addUsage(total: Usage, next: Usage): Usage {
  return { model: next.model, inputTokens: total.inputTokens + next.inputTokens, outputTokens: total.outputTokens + next.outputTokens, costUsd: total.costUsd + next.costUsd };
}

async function post(apiKey: string, path: string, body: unknown, timeoutMs: number, retry = true): Promise<Record<string, unknown>> {
  let lastError: Error | null = null;
  const attempts = retry ? 2 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`${BASE_URL}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) {
        const data = row(await response.json());
        // Gateways can return a generation error inside an HTTP 200 response.
        if (data.error) throw new ProviderError(number(row(data.error).code) || 502, "generation failed");
        return data;
      }
      lastError = new ProviderError(response.status, (await response.text()).slice(0, 300));
      if (response.status !== 429 && response.status < 500) break;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (error instanceof ProviderError && error.status < 500 && error.status !== 429) break;
    }
    if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 800));
  }
  throw lastError ?? new Error("request failed");
}

export class ProviderError extends Error {
  constructor(public status: number, detail: string) {
    super(`provider returned ${status}: ${detail}`);
  }
  get isKeyProblem() {
    return this.status === 401 || this.status === 402 || this.status === 403;
  }
}

/** Read only public citation metadata, never reasoning or intermediate tool text. */
function citationsFrom(annotations: unknown): Citation[] {
  return list(annotations).flatMap((annotation) => {
    const a = row(annotation);
    if (a.type !== "url_citation") return [];
    const c = a.url_citation ? row(a.url_citation) : a;
    if (typeof c.url !== "string") return [];
    try {
      const url = new URL(c.url);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password) return [];
      return [{ url: url.href, title: typeof c.title === "string" ? c.title : url.hostname }];
    } catch { return []; }
  });
}

function chatText(content: unknown): string {
  if (typeof content === "string") return content;
  return list(content).filter((part) => row(part).type === "text").map((part) => row(part).text).filter((text): text is string => typeof text === "string").join("\n");
}

function parseReply(data: Record<string, unknown>, web: boolean) {
  if (web) {
    const message = list(data.output).map(row).filter((item) => item.type === "message" && item.role === "assistant").at(-1);
    const parts = list(message?.content).map(row);
    return {
      text: parts.filter((part) => part.type === "output_text").map((part) => typeof part.text === "string" ? part.text : "").join("\n").trim(),
      refusal: parts.find((part) => part.type === "refusal")?.refusal,
      finish: data.status === "incomplete" ? String(row(data.incomplete_details).reason ?? "incomplete") : String(data.status ?? "unknown"),
      truncated: data.status === "incomplete",
      failed: data.status !== "completed" && data.status !== "incomplete",
      citations: parts.flatMap((part) => citationsFrom(part.annotations)),
    };
  }
  const choice = row(list(data.choices)[0]);
  const message = row(choice.message);
  return { text: chatText(message.content).trim(), refusal: message.refusal, finish: String(choice.finish_reason ?? "unknown"), truncated: choice.finish_reason === "length", failed: false, citations: citationsFrom(message.annotations) };
}

export interface OpenRouterConfig {
  webEnabled?: boolean;
  /**
   * Preferred providers per model id. A model on OpenRouter is served by
   * several companies at different prices, and prompt caching only works when
   * the same one answers every turn. With this, that provider is asked first;
   * the others remain as fallbacks, so an outage costs a cache miss, not a reply.
   */
  providers?: Record<string, string[]>;
}

export function openRouter(apiKey: string, config: OpenRouterConfig = {}): Llm {
  const webEnabled = config.webEnabled ?? true;
  return {
    capabilities: { web: webEnabled },
    async chat(messages: ChatMessage[], options: ChatOptions) {
      const web = !!options.web && webEnabled && !options.json;
      const hasImages = messages.some((message) => message.images?.length);
      if (messages.some((message) => message.images?.length && message.role !== "user")) throw new Error("images must be attached to user messages");
      const responses = web || hasImages;
      const input = messages.map((message) => message.images?.length ? {
        role: message.role,
        content: [
          { type: "input_text", text: message.content },
          ...message.images.flatMap((image, index) => [
            { type: "input_text", text: `Image ${index + 1}${image.origin === "reply" ? " (replied-to picture)" : ""}:` },
            { type: "input_image", image_url: `data:${image.mimeType};base64,${Buffer.from(image.data).toString("base64")}`, detail: "high" },
          ]),
        ],
      } : { role: message.role, content: message.content });
      let budget = Math.max(options.maxTokens ?? 1500, 2048);
      let usage: Usage = { model: options.model, inputTokens: 0, outputTokens: 0, costUsd: 0 };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const order = config.providers?.[options.model];
        const common = {
          model: options.model, temperature: options.temperature ?? 0.7, reasoning: { effort: "low", exclude: true },
          ...(order?.length ? { provider: { order, allow_fallbacks: true } } : {}),
        };
        const body = responses ? {
          ...common, input, max_output_tokens: budget,
          ...(options.json ? { text: { format: { type: "json_object" } } } : {}),
          ...(web ? { tools: [
            { type: "openrouter:web_search", parameters: { engine: "exa", max_results: 3, max_total_results: 6, max_uses: 2, max_characters: 4000 } },
            { type: "openrouter:web_fetch", parameters: { engine: "openrouter", max_uses: 2, max_content_tokens: 6000 } },
          ],
          max_tool_calls: 4 } : {}),
        } : {
          ...common, messages, max_tokens: budget, usage: { include: true },
          ...(options.json ? { response_format: { type: "json_object" } } : {}),
        };
        let data;
        try {
          data = await post(apiKey, responses ? "/responses" : "/chat/completions", body, responses ? 120_000 : 90_000, !responses);
        } catch (error) {
          if (hasImages && error instanceof ProviderError && error.status === 400) {
            throw new LlmResponseError(`Image request rejected: model=${options.model} status=400`, usage, { cause: error, kind: "image_unavailable" });
          }
          if (web && error instanceof ProviderError && (error.status === 400 || error.status === 403)) {
            throw new LlmResponseError(`Web request rejected: model=${options.model} status=${error.status}; check OpenRouter tool/model permissions`, usage, { cause: error, kind: "web_unavailable" });
          }
          // Retain costs from a preceding empty generation even if retry transport fails.
          if (usage.outputTokens || usage.inputTokens || usage.costUsd) throw new LlmResponseError(`retry request failed for ${options.model}`, usage, { cause: error, kind: "request_failed" });
          throw error;
        }
        usage = addUsage(usage, usageFrom(data, options.model));
        const parsed = parseReply(data, responses);
        const validJson = !options.json || parseJsonObject(parsed.text) !== null;
        if (parsed.text && validJson && !parsed.truncated && !parsed.failed) return { text: parsed.text, usage, citations: parsed.citations };
        if (typeof parsed.refusal === "string" && parsed.refusal.trim() && !options.json) return { text: parsed.refusal, usage };
        const details = row(row(data.usage).completion_tokens_details ?? row(data.usage).output_tokens_details);
        // Metadata only: never log prompts, API keys, page contents or reasoning.
        const diagnostic = `model=${options.model} request=${typeof data.id === "string" ? data.id : "unknown"} finish=${parsed.finish} token_budget=${budget} output_tokens=${usage.outputTokens} reasoning_tokens=${number(details.reasoning_tokens)}`;
        if (attempt === 1 || parsed.refusal || parsed.finish === "content_filter" || parsed.failed) {
          throw new LlmResponseError(`No usable model answer (${diagnostic})`, usage);
        }
        console.warn(`[llm] retrying empty, incomplete or invalid answer (${diagnostic})`);
        budget = Math.min(Math.max(budget * 2, 4096), 8192);
      }
      throw new LlmResponseError(`No usable model answer for ${options.model}`, usage);
    },
    async embed(texts: string[], model: string) {
      if (!texts.length) return { vectors: [], usage: { model, inputTokens: 0, outputTokens: 0, costUsd: 0 } };
      const data = await post(apiKey, "/embeddings", { model, input: texts, dimensions: EMBEDDING_DIMENSIONS, encoding_format: "float" }, 30_000);
      const vectors = list(data.data).map((item) => row(item).embedding).filter((v): v is number[] => Array.isArray(v) && v.length === EMBEDDING_DIMENSIONS);
      if (vectors.length !== texts.length) throw new Error("embedding count or size mismatch");
      return { vectors, usage: usageFrom(data, model) };
    },
  };
}
