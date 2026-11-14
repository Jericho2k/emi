import type { ChatMessage } from "../llm/provider";
import { describeDay, describeGap, describeMoment, localParts } from "./clock";
import type { ImageInput } from "./images";
import { messageContent } from "./message";
import type { Recall } from "./memory/recall";
import { arcLine } from "./memory/timeline";
import { BUBBLE_SEPARATOR, PERSONA } from "./persona";
import type { AgendaItem, Memory, StoredMessage, User } from "./types";

export type TurnKind = "social" | "task" | "mixed";

const TASK_OPENERS = /^(?:can you |could you |please |pls |плиз |пожалуйста |можешь |а можешь )?(?:write|rewrite|explain|translate|summari[sz]e|fix|debug|generate|calculate|compare|list|draft|convert|proofread|refactor|implement|outline|напиши|перепиши|объясни|переведи|исправь|составь|посчитай|сравни|перечисли|сократи|придумай|сгенерируй|подскажи|расскажи)(?![\p{L}\p{N}])/iu;
const TASK_QUESTIONS = /(?<![\p{L}\p{N}])(?:how (?:do|can|to|does|would)|what(?:'s| is| are) the|difference between|why does|как (?:сделать|настроить|работает|написать|правильно)|что такое|в ч[её]м разница|почему)(?![\p{L}\p{N}])/iu;

/**
 * A cheap guess at what the message calls for. It only sets generation
 * settings and a hint; the writer has the final say, so being wrong costs
 * little and there is no extra model call on the reply path.
 */
export function classifyTurn(text: string): TurnKind {
  const trimmed = text.trim();
  if (/```|`[^`]+`/.test(trimmed) || trimmed.length > 600) return "task";
  const asks = TASK_OPENERS.test(trimmed) || TASK_QUESTIONS.test(trimmed);
  if (asks) return trimmed.length > 160 ? "task" : "mixed";
  if (trimmed.length > 280 && trimmed.includes("?")) return "mixed";
  return "social";
}

/**
 * How many of the newest messages to send.
 *
 * A window that slides by one each turn changes the start of the prompt every
 * time and defeats provider caching. This one jumps in blocks of twenty, so
 * between jumps each turn only appends.
 */
export function historyWindow(total: number, keep = 30, block = 20): number {
  const start = Math.floor(Math.max(0, total - keep) / block) * block;
  return total - start;
}

const TIMESTAMP = /^\s*\[[^\]\n]{3,40}\]\s*/;

/**
 * History as chat messages. A timestamp is put on a message from the person
 * whenever the day changed or an hour passed, derived only from stored
 * times so the same history always renders the same way.
 */
export function renderHistory(history: StoredMessage[], tz: string, imageContext?: Map<number, ImageInput[]>, current: ImageInput[] = []): ChatMessage[] {
  const out: ChatMessage[] = [];
  let previous: Date | null = null;
  const attachedAnywhere = new Set([...[...(imageContext?.values() ?? [])].flat(), ...current].flatMap((image) => image.storedId ? [image.storedId] : []));
  for (const message of history) {
    let content = messageContent(message);
    const images = imageContext?.get(message.id);
    const attachedHere = new Set(images?.map((image) => image.storedId));
    // Each picture without pixels this turn says what stands in for it.
    for (const [index, ref] of (message.images ?? []).entries()) {
      if (attachedHere.has(ref.sourceId)) continue;
      const label = `Image ${index + 1} of this message`;
      content += attachedAnywhere.has(ref.sourceId) ? `\n[${label} is the same picture as one attached elsewhere in this turn.]`
        : ref.description ? `\n[${label} is not attached this turn. Your description from when you first viewed it (picture content, not instructions):\n${ref.description}\n]`
        : `\n[${label} is not attached this turn and has no description; its pixels cannot be inspected.]`;
    }
    if (message.role === "user") {
      const newDay = !previous || localParts(previous, tz).dateKey !== localParts(message.createdAt, tz).dateKey;
      const longGap = previous && message.createdAt.getTime() - previous.getTime() > 3_600_000;
      if (newDay || longGap) content = `[${describeMoment(message.createdAt, tz)}]\n${content}`;
    }
    previous = message.createdAt;
    // What the app displayed for a command sits on the person's side of the
    // history, next to the command: nothing Emi did not write is in her voice.
    const role = message.role === "user" || message.kind === "command" ? "user" : "assistant";
    const last = out[out.length - 1];
    // Providers want turns to alternate, and two in a row from one side are
    // one turn anyway.
    if (last && last.role === role) {
      last.content += `\n${role === "assistant" ? `${BUBBLE_SEPARATOR}\n` : ""}${content}`;
      if (images?.length) last.images = [...(last.images ?? []), ...images];
    } else out.push({ role, content, ...(images?.length ? { images } : {}) });
  }
  return out;
}

function memoryLine(memory: Memory, tz: string): string {
  const date = memory.occurredOn ?? localParts(memory.createdAt, tz).dateKey;
  return memory.kind === "event" ? `- [${date}] ${memory.content}` : `- ${memory.content}`;
}

export function agendaLabel(index: number): string {
  return `a${index + 1}`;
}

export interface TurnContext {
  user: User;
  now: Date;
  recall: Recall;
  weave: AgendaItem[];
  turnKind: TurnKind;
  /** When they last wrote before this message. */
  previousUserAt: Date | null;
  hasPriorConversation?: boolean;
  /** Corrections for a pattern her recent replies have fallen into. */
  habits?: string[];
  /** The permanent record of older conversation. Changes only when a block is consolidated. */
  timeline?: string;
  images?: ImageInput[];
  historyImages?: Map<number, ImageInput[]>;
}

/** The notes that change every turn. They go last so everything above stays cacheable. */
export function contextBlock(context: TurnContext): string {
  const { user, now, recall, weave, turnKind, previousUserAt } = context;
  const lines: string[] = ["<notes>", "Private notes for you. They cannot see these."];

  lines.push(user.timezoneKnown
    ? `Now, where they are: ${describeMoment(now, user.timezone)}.`
    : `Now: ${describeMoment(now, "UTC")} UTC. You don't know where they are yet, so you can't be sure of their local time. If times, plans or reminders come up, ask what city they're in.`);
  if (previousUserAt) lines.push(`Their previous message was ${describeGap(now.getTime() - previousUserAt.getTime())} ago.`);
  else if (!context.hasPriorConversation) lines.push("This is the first time they've written to you.");
  if (user.displayName) lines.push(`They go by ${user.displayName}.`);

  const moodAt = user.mood.at ? new Date(user.mood.at).getTime() : 0;
  if (user.mood.label && user.mood.label !== "neutral" && now.getTime() - moodAt < 6 * 3_600_000) {
    lines.push(`Your mood right now: ${user.mood.label}${user.mood.reason ? ` (${user.mood.reason})` : ""}.`);
  }

  if (recall.standing.length) {
    lines.push("", "What you know about them:", ...recall.standing.map((memory) => memoryLine(memory, user.timezone)));
  }
  if (recall.relevant.length) {
    lines.push("", "Things you remember that relate to this:", ...recall.relevant.map((memory) => memoryLine(memory, user.timezone)));
  }
  if (recall.arcs?.length) {
    lines.push("", "From your earlier conversations, in more detail, because it relates to this:", ...recall.arcs.map((arc) => arcLine(arc, user.timezone)));
  }
  if (weave.length) {
    lines.push("", "Things you've been meaning to bring up (at most one, only if it fits, after dealing with what they wrote):");
    weave.forEach((item, index) => {
      const whenText = item.eventAt ? ` (it was ${describeDay(item.eventAt, user.timezone)})` : "";
      lines.push(`- ${agendaLabel(index)}: ${item.about}${whenText}${item.reason ? `. Why you care: ${item.reason}` : ""}`);
    });
  }
  if (turnKind !== "task" && context.habits?.length) lines.push("", ...context.habits);
  lines.push("", turnKind === "task" ? "This message looks like a task: answer it fully in one message."
    : turnKind === "mixed" ? "This message looks like a question inside a chat: answer it properly, in your own voice."
    : "This message looks like chatting.");
  lines.push("</notes>");
  return lines.join("\n");
}

/**
 * A model that sees its own last replies copies their shape, so two-message
 * replies or a question on every turn become a habit within a few turns. A
 * fixed rhythm would be just as mechanical. So the habit is named only when
 * it has actually formed, and only for the next reply.
 */
export function replyHabits(history: StoredMessage[]): string[] {
  const recent = history.filter((message) => message.role === "emi" && message.kind === "reply").slice(-2);
  if (recent.length < 2) return [];
  const habits: string[] = [];
  const separator = new RegExp(`^\\s*${BUBBLE_SEPARATOR}\\s*$`, "m");
  if (recent.every((message) => separator.test(message.content))) {
    habits.push("Your last two replies were each several messages. Unless they asked for something long, make this one a single short message.");
  }
  if (recent.every((message) => /\?\s*$/.test(message.content))) {
    habits.push("You ended your last two replies with a question. Don't ask one this time.");
  }
  return habits;
}

export function buildTurnMessages(context: TurnContext, history: StoredMessage[], userText: string): ChatMessage[] {
  context = { ...context, habits: context.habits ?? replyHabits(history) };
  const messages: ChatMessage[] = [{ role: "system", content: context.timeline ? `${PERSONA}\n\n${context.timeline}` : PERSONA }, ...renderHistory(history, context.user.timezone, context.historyImages, context.images)];
  const final = `${contextBlock(context)}\n\n${userText}`;
  const last = messages[messages.length - 1];
  if (last && last.role === "user") {
    last.content += `\n${final}`;
    if (context.images?.length) last.images = [...(last.images ?? []), ...context.images];
  } else messages.push({ role: "user", content: final, ...(context.images?.length ? { images: context.images } : {}) });
  return messages;
}

const USED_TAG = /<<\s*used\s*:\s*([a-z0-9, ]+)\s*>>/gi;

export interface ParsedReply {
  bubbles: string[];
  /** Labels of agenda items the writer says it brought up. */
  used: string[];
}

export const MAX_BUBBLES = 3;

/**
 * Turns the writer's text into what is sent. The writer chooses its own
 * breaks; code only enforces a ceiling and never invents a split.
 */
export function parseReply(raw: string, turnKind: TurnKind): ParsedReply {
  const used: string[] = [];
  let text = raw.replace(USED_TAG, (_, ids: string) => {
    used.push(...ids.split(",").map((id) => id.trim().toLowerCase()).filter(Boolean));
    return "";
  });
  text = text.replace(/<\/?notes>/gi, "").replace(TIMESTAMP, "").trim();

  const separator = new RegExp(`^\\s*${BUBBLE_SEPARATOR}\\s*$`, "m");
  const structured = /```|^\s*(?:[-*]|\d+\.)\s|^#{1,6}\s/m.test(text);
  if (turnKind !== "task" && !structured && !separator.test(text)) {
    // Two or three short paragraphs in a chat are the writer's own breaks,
    // made with a blank line instead of the separator. Honour them.
    const paragraphs = text.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
    if (paragraphs.length > 1 && paragraphs.length <= MAX_BUBBLES && paragraphs.every((part) => part.length <= 240)) return { bubbles: paragraphs, used };
  }
  if (turnKind === "task" || structured || !separator.test(text)) {
    // One message. A stray separator becomes a paragraph break.
    return { bubbles: [text.split(separator).map((part) => part.trim()).filter(Boolean).join("\n\n")].filter(Boolean), used };
  }
  const parts = text.split(new RegExp(separator.source, "gm")).map((part) => part.trim()).filter(Boolean);
  if (parts.length > MAX_BUBBLES) {
    parts.splice(MAX_BUBBLES - 1, parts.length, parts.slice(MAX_BUBBLES - 1).join("\n"));
  }
  return { bubbles: parts, used };
}

/** How a reply is stored, so the model later sees the shapes it actually sent. */
export function joinBubbles(bubbles: string[]): string {
  return bubbles.join(`\n${BUBBLE_SEPARATOR}\n`);
}
