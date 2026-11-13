import { LlmResponseError } from "../llm/provider";
import { ProviderError } from "../llm/openrouter";
import { absorbOnUserMessage, openForWeave, setStatus } from "./agenda/store";
import { recall } from "./memory/recall";
import { agendaLabel, buildTurnMessages, classifyTurn, historyWindow, joinBubbles, parseReply, type TurnKind } from "./prompt";
import { messageContent } from "./message";
import type { Deps, IncomingMessage } from "./types";
import { attachSources, webContext } from "./web";
import { addMessage, getUser, messageCount, recentMessages, recordUsage } from "./users";

export interface TurnResult {
  bubbles: string[];
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
  const incoming = typeof input === "string" ? [{ text: input }] : input;
  if (!incoming.length) throw new Error("a turn needs at least one message");
  const text = incoming.map((message) => message.text).join("\n");
  const content = incoming.map(messageContent).join("\n\n");
  const { db } = deps;
  const user = await getUser(db, userId);
  if (!user) throw new Error(`unknown user ${userId}`);
  const now = deps.clock();
  const turnKind = classifyTurn(text);

  // Read the history before storing, so the new message is not in it twice.
  const history = await recentMessages(db, userId, historyWindow(await messageCount(db, userId)));
  const previousUserAt = user.lastUserMessageAt;
  for (const message of incoming) {
    await addMessage(db, { userId, role: "user", content: message.text, replyTo: message.replyTo, at: now });
  }

  // They wrote first: anything she planned to send becomes something she can
  // raise here instead. Done before the reply so no ping can race it.
  const weave = await openForWeave(db, userId, now);
  await absorbOnUserMessage(db, user, now);

  const llm = deps.llmFor(user);
  if (!llm) return { bubbles: [NO_KEY], turnKind, problem: "no_key", recalledIds: [] };

  let queryVector: number[] | null = null;
  try {
    const embedded = await llm.embed([text.slice(0, 2000)], deps.models.embedding);
    queryVector = embedded.vectors[0] ?? null;
    await recordUsage(db, userId, "embed_query", embedded.usage, now);
  } catch {
    // Word matching alone still recalls; a reply never waits on embeddings.
  }
  const recalled = await recall(db, userId, text, queryVector, now);

  const messages = buildTurnMessages({
    user, now, recall: recalled, weave, turnKind, previousUserAt,
    hasPriorConversation: history.length > 0 || incoming.some((message) => !!message.replyTo),
  }, history, content);
  messages[0]!.content += `\n\n${webContext(!!llm.capabilities?.web)}`;
  let reply;
  try {
    reply = await llm.chat(messages, { model: deps.models.writer, ...SETTINGS[turnKind], web: !!llm.capabilities?.web });
  } catch (error) {
    if (error instanceof LlmResponseError) {
      await recordUsage(db, userId, "reply_failed", error.usage, now);
      console.warn("[reply]", error.message);
      const notice = error.kind === "web_unavailable"
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
  const bubbles = attachSources(parsed.bubbles.length ? parsed.bubbles : [reply.text.trim()], reply.citations);
  for (const [index, item] of weave.entries()) {
    if (parsed.used.includes(agendaLabel(index))) await setStatus(db, item.id, "woven", "brought up in conversation", now);
  }
  await addMessage(db, { userId, role: "emi", content: joinBubbles(bubbles), at: deps.clock() });

  return { bubbles, turnKind, recalledIds: [...recalled.standing, ...recalled.relevant].map((memory) => memory.id) };
}
