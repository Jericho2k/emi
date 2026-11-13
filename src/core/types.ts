import type { Db } from "../db";
import type { Llm } from "../llm/provider";
import type { Clock } from "./clock";

export type Initiative = "off" | "low" | "medium" | "high";
export const INITIATIVE_LEVELS: Initiative[] = ["off", "low", "medium", "high"];

export interface Mood {
  label?: string;
  reason?: string;
  at?: string;
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
  encryptedApiKey: string | null;
  lastUserMessageAt: Date | null;
  lastEmiMessageAt: Date | null;
  extractedThrough: number;
  lastPlannedOn: string | null;
  createdAt: Date;
}

export type MemoryKind = "identity" | "boundary" | "relationship" | "preference" | "state" | "event";
export const MEMORY_KINDS: MemoryKind[] = ["identity", "boundary", "relationship", "preference", "state", "event"];

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
  replyTo?: ReplyContext;
}

export interface StoredMessage {
  id: number;
  role: "user" | "emi";
  content: string;
  kind: "reply" | "proactive" | "command";
  replyTo?: ReplyContext;
  agendaItemId: string | null;
  createdAt: Date;
}

export interface Models {
  writer: string;
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
}

/** How the core reaches a person when it speaks first. */
export interface Outbound {
  send(userId: string, bubbles: string[]): Promise<void>;
}
