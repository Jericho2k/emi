import { LlmResponseError } from "../llm/provider";
import { ProviderError } from "../llm/openrouter";
import { conversationDeps, ConversationReset, inConversation } from "./conversation";
import { absorbOnUserMessage, openForWeave, setStatus } from "./agenda/store";
import { bondSnapshot } from "./bond";
import { runExtraction } from "./extraction";
import { allowance, allowanceLines, permitted, storedExtras } from "./expression";
import { ensureInnerDay, onHerMind } from "./inner";
import { recall } from "./memory/recall";
import { runConsolidation, timelineFor } from "./memory/timeline";
import { agendaLabel, buildTurnMessages, classifyTurn, historyWindow, parseReply, storedReply, type TurnKind } from "./prompt";
import { imageHistory, validateImages, VISION_CONTEXT } from "./images";
import { prepareImages } from "./image-prep";
import { messageContent } from "./message";
import type { Deps, Extras, IncomingMessage } from "./types";
import { attachSources, webContext } from "./web";
import { addMessage, getUser, messageCount, recentMessages, recordUsage } from "./users";

export interface TurnResult {
  /** What to send. Empty when she only reacted. */
  bubbles: string[];
  /** An emoji reaction to put on their last message. */
  reaction?: string;
  /** A sticker, voice note or pinned sulk she may send, already checked against today's allowance. */
  extras?: Extras;
  turnKind: TurnKind;
  /** Set when no reply could be written; `bubbles` then holds a plain notice. */
  problem?: "no_key" | "key_rejected" | "model_unavailable";
  /** Memories used this turn, handed to the extractor so it can spot replacements. */
  recalledIds: string[];
}

const NO_KEY = "I need an OpenRouter key before I can talk. Send /key followed by your key and we're set.";
const KEY_REJECTED = "Your OpenRouter key was rejected (wrong key, or out of credit). Send /key with a working one and I'm back.";

const SETTINGS: Record<TurnKind, { temperature: number; maxTokens: number }> = {
  social: { temperature: 0.9, maxTokens: 500 },
  mixed: { temperature: 0.7, maxTokens: 1800 },
  task: { temperature: 0.4, maxTokens: 3500 },
};

/**
 * One message from the person in, one reply out.
 *
 * The writer may use bounded read-only web tools; the provider handles their
 * execution. Memory extraction still happens after the reply.
 */
export async function handleTurn(deps: Deps, userId: string, input: string | IncomingMessage[]): Promise<TurnResult> {
  deps = await conversationDeps(deps, userId);
  const raw = typeof input === "string" ? [{ text: input }] : input;
  if (!raw.length) throw new Error("a turn needs at least one message");
  validateImages(raw.flatMap((message) => message.images ?? []));
  // Shrunk once here, so storage and every later replay use the smaller copy.
  const incoming: IncomingMessage[] = [];
  for (const message of raw) incoming.push(message.images?.length ? { ...message, images: await prepareImages(message.images) } : message);
  const images = incoming.flatMap((message) => message.images ?? []);
  validateImages(images);
  const text = incoming.map((message) => message.text).join("\n");
  const content = incoming.map(messageContent).join("\n\n");
  const { db } = deps;
  const user = await getUser(db, userId);
  if (!user) throw new Error(`unknown user ${userId}`);
  const now = deps.clock();
  const classified = classifyTurn(text);
  const turnKind = images.length && classified === "social" ? "mixed" : classified;

  // Read the history before storing, so the new message is not in it twice.
  const history = await recentMessages(db, userId, historyWindow(await messageCount(db, userId)));
  const previousUserAt = user.lastUserMessageAt;
  for (const message of incoming) {
    await addMessage(db, { userId, role: "user", content: message.text, replyTo: message.replyTo, images: message.images, at: now });
  }

  // They wrote first: anything she planned to send becomes something she can
  // raise here instead. Done before the reply so no ping can race it.
  const weave = await openForWeave(db, userId, now);
  await absorbOnUserMessage(db, user, now);

  const llm = deps.llmFor(user);
  if (!llm) return { bubbles: [NO_KEY], turnKind, problem: "no_key", recalledIds: [] };

  let queryVector: number[] | null = null;
  try {
    const embedded = text.trim() ? await llm.embed([text.slice(0, 2000)], deps.models.embedding) : null;
    queryVector = embedded?.vectors[0] ?? null;
    if (embedded) await recordUsage(db, userId, "embed_query", embedded.usage, now);
  } catch {
    // Word matching alone still recalls; a reply never waits on embeddings.
  }
  const recalled = await recall(db, userId, text, queryVector, now);
  const allowed = await allowance(deps, user, now);

  const messages = buildTurnMessages({
    user, now, recall: recalled, weave, turnKind, previousUserAt, timeline: await timelineFor(db, user),
    bond: await bondSnapshot(db, user, now), onHerMind: onHerMind(user, now),
    allowance: allowanceLines(allowed, deps.expression?.voiceTags, text),
    images, historyImages: await imageHistory(db, userId, history, images, now),
    hasPriorConversation: history.length > 0 || incoming.some((message) => !!message.replyTo),
  }, history, content);
  messages[0]!.content += `\n\n${webContext(!!llm.capabilities?.web)}\n\n${VISION_CONTEXT}`;
  const hasImages = messages.some((message) => message.images?.length);
  const model = hasImages ? deps.models.vision ?? deps.models.writer : deps.models.writer;
  let reply;
  try {
    reply = await llm.chat(messages, { model, ...SETTINGS[turnKind], web: !!llm.capabilities?.web });
  } catch (error) {
    if (error instanceof LlmResponseError) {
      await recordUsage(db, userId, "reply_failed", error.usage, now);
      console.warn("[reply]", error.message);
      const notice = error.kind === "image_unavailable"
        ? "the selected model couldn't read that image. try a smaller PNG or JPEG, or check that the model supports images."
        : error.kind === "web_unavailable"
        ? "my web request was rejected. the OpenRouter model or tool permissions need checking; I couldn't verify that online."
        : error.kind === "request_failed"
          ? "the request failed while I was trying again. try that in a moment."
          : "my model didn't give me a usable answer. try that again in a moment.";
      await addMessage(db, { userId, role: "emi", content: notice, kind: "command", at: deps.clock() });
      return { bubbles: [notice], turnKind, problem: "model_unavailable", recalledIds: [] };
    }
    if (error instanceof ProviderError && error.isKeyProblem) {
      return { bubbles: [KEY_REJECTED], turnKind, problem: "key_rejected", recalledIds: [] };
    }
    throw error;
  }
  await recordUsage(db, userId, "reply", reply.usage, now);

  const parsed = parseReply(reply.text, turnKind);
  const { extras, asText } = permitted(parsed.extras, allowed);
  const written = [...parsed.bubbles, ...asText];
  // A reaction, a sticker or a voice note can be the whole reply.
  const wordless = !written.length && !!(parsed.reaction || extras.sticker || extras.voice || extras.pin);
  const bubbles = attachSources(written.length || wordless ? written : [reply.text.trim()], reply.citations);
  for (const [index, item] of weave.entries()) {
    if (parsed.used.includes(agendaLabel(index))) await setStatus(db, item.id, "woven", "brought up in conversation", now);
  }
  const markers = storedExtras({ ...extras, ...(extras.pin ? { pinned: { text: extras.pin, detail: {} } } : {}) });
  await addMessage(db, { userId, role: "emi", content: storedReply(bubbles, parsed.reaction, markers), at: deps.clock() });

  return {
    bubbles, turnKind, ...(parsed.reaction ? { reaction: parsed.reaction } : {}),
    ...(Object.keys(extras).length ? { extras } : {}),
    recalledIds: [...recalled.standing, ...recalled.relevant, ...recalled.us, ...recalled.self].map((memory) => memory.id),
  };
}

/**
 * Everything that follows a reply, off the reply path: what to remember, the
 * long timeline, and what is on her mind today. Each step fails on its own.
 */
export async function afterTurn(deps: Deps, userId: string, result: Pick<TurnResult, "recalledIds">): Promise<void> {
  await inConversation(deps, userId, async (deps) => {
    for (const [label, step] of [
      ["extraction", () => runExtraction(deps, userId, { memoryIds: result.recalledIds })],
      ["timeline", () => runConsolidation(deps, userId)],
      ["inner", () => ensureInnerDay(deps, userId)],
    ] as const) {
      try { await step(); }
      catch (error) {
        if (error instanceof ConversationReset) throw error;
        console.warn(`[${label}]`, error);
      }
    }
  });
}
