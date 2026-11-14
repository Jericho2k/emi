import type { Db } from "../db";
import type { Llm } from "../llm/provider";
import type { ImageInput, ImageReference } from "./images";
import type { Clock } from "./clock";

export type Initiative = "off" | "low" | "medium" | "high";
export const INITIATIVE_LEVELS: Initiative[] = ["off", "low", "medium", "high"];

export interface Mood {
  label?: string;
  reason?: string;
  at?: string;
}

/**
 * How the relationship stands, beyond facts. Each value is 0..1. Warmth and
 * trust move slowly; irritation rises fast and fades on its own (see bond.ts).
 */
export interface Bond {
  warmth?: number;
  trust?: number;
  irritation?: number;
  /** When irritation was last set, so it can fade from there. */
  irritationAt?: string;
  /** What irritated her, in a few words. */
  irritationReason?: string;
}

/** One line of what was on Emi's mind on a local day. */
export interface InnerDay {
  day: string;
  thought: string;
}

export interface User {
  id: string;
  displayName: string | null;
  timezone: string;
  timezoneKnown: boolean;
  initiative: Initiative;
  brushoffCount: number;
  quietStart: number;
  quietEnd: number;
  dailyCapUsd: number;
  mood: Mood;
  bond: Bond;
  innerDays: InnerDay[];
  lastSpontaneousAt: Date | null;
  /** Whether she may do playful things beyond words when she is in a mood. */
  mischief: boolean;
  encryptedApiKey: string | null;
  lastUserMessageAt: Date | null;
  lastEmiMessageAt: Date | null;
  extractedThrough: number;
  consolidatedThrough: number;
  lastPlannedOn: string | null;
  createdAt: Date;
}

/** What the person told her about themselves. */
export type UserMemoryKind = "identity" | "boundary" | "relationship" | "preference" | "state" | "event";
export const USER_MEMORY_KINDS: UserMemoryKind[] = ["identity", "boundary", "relationship", "preference", "state", "event"];
/** self: what Emi said about herself. us: what belongs to the two of them. */
export type SharedMemoryKind = "self" | "us";
export const SHARED_MEMORY_KINDS: SharedMemoryKind[] = ["self", "us"];
export type MemoryKind = UserMemoryKind | SharedMemoryKind;
export const MEMORY_KINDS: MemoryKind[] = [...USER_MEMORY_KINDS, ...SHARED_MEMORY_KINDS];

export interface Memory {
  id: string;
  userId: string;
  kind: MemoryKind;
  content: string;
  status: "active" | "superseded" | "deleted";
  pinned: boolean;
  source: "stated" | "user";
  evidence: string;
  occurredOn: string | null;
  storyline: string | null;
  lastRelevantAt: Date | null;
  createdAt: Date;
}

export type AgendaKind = "reminder" | "followup" | "initiative";
export type AgendaStatus = "pending" | "woven" | "pinged" | "done" | "cancelled" | "expired";

export interface AgendaItem {
  id: string;
  userId: string;
  kind: AgendaKind;
  about: string;
  reason: string;
  importance: 1 | 2 | 3;
  eventAt: Date | null;
  windowStart: Date;
  windowEnd: Date;
  pingAt: Date | null;
  closesWhen: string;
  status: AgendaStatus;
  attempts: number;
  pingedAt: Date | null;
  /** Planned with no reason but that she thought of them. */
  spontaneous: boolean;
  createdAt: Date;
}

/** A snapshot of what someone replied to, independent of the chat channel. */
export interface ReplyContext {
  author: "emi" | "user" | "other";
  text?: string;
  quote?: string;
}

export interface IncomingMessage {
  text: string;
  images?: ImageInput[];
  replyTo?: ReplyContext;
}

export interface StoredMessage {
  id: number;
  role: "user" | "emi";
  content: string;
  kind: "reply" | "proactive" | "command";
  images?: ImageReference[];
  replyTo?: ReplyContext;
  agendaItemId: string | null;
  createdAt: Date;
}

export interface Models {
  writer: string;
  /** Defaults to the writer; override only when using a text-only writer. */
  vision?: string;
  utility: string;
  embedding: string;
}

/** Everything the core needs from the outside world. */
export interface Deps {
  db: Db;
  clock: Clock;
  /** Uniform in [0, 1). Injected so timing is testable. */
  random: () => number;
  models: Models;
  /** The model client for this person, or null when they have no usable key. */
  llmFor(user: User): Llm | null;
  /** What she can send besides text. Filled in by the channel and the config. */
  expression?: ExpressionKit;
}

/** Besides text, what a reply can carry. */
export interface Extras {
  /** An emoji naming the sticker to send; the channel picks one with that emoji. */
  sticker?: string;
  /** Text to speak as a voice note. */
  voice?: string;
  /** A short status to pin in the chat while she sulks. */
  pin?: string;
}

export interface ExpressionKit {
  /** Emoji of the stickers the channel can send. Empty when it has none. */
  stickers(): string[];
  /** Turns text into a voice note (MP3). Absent when no voice is configured. */
  speak?: (text: string) => Promise<Uint8Array>;
  /** Whether the voice model understands audio tags like [sighs]. */
  voiceTags?: boolean;
}

/** A playful change she made and will undo herself. */
export interface MischiefAct {
  id: string;
  userId: string;
  kind: "pin";
  detail: Record<string, unknown>;
  createdAt: Date;
}

/** How the core reaches a person when it speaks first. */
export interface Outbound {
  send(userId: string, bubbles: string[], extras?: Extras): Promise<SentExtras>;
  /** Reverses a playful change. Absent on channels that cannot make any. */
  undo?(userId: string, act: MischiefAct): Promise<void>;
}

/** What the channel actually did with the extras, so it can be stored and undone. */
export interface SentExtras {
  sticker?: string;
  voice?: string;
  /** The channel's handle on the pinned message, needed to unpin it. */
  pinned?: { text: string; detail: Record<string, unknown> };
}
