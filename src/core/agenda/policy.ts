import type { AgendaKind, Initiative } from "../types";

/**
 * WHEN EMI MAY SPEAK. The model says what is worth bringing up and when the
 * person's own event is; this file alone decides when she writes. A model
 * never states a send time.
 */

const HOUR = 3_600_000;
const MINUTE = 60_000;

/** How long the chat must have been quiet before she may write first. */
export const SILENCE_HOURS: Record<Initiative, number> = { off: Infinity, low: 8, medium: 5, high: 3 };

/** Unasked messages per local day. Reminders the person requested do not count. */
export const DAILY_PING_BUDGET: Record<Initiative, number> = { off: 0, low: 1, medium: 1, high: 2 };

export interface Windows {
  /** From when it makes sense to bring this up. */
  windowStart: Date;
  /** After this it is stale and quietly dropped. */
  windowEnd: Date;
  /** When she would write unprompted. Null: only if they are already talking. */
  pingAt: Date | null;
}

export interface WindowInput {
  kind: Exclude<AgendaKind, "initiative">;
  importance: 1 | 2 | 3;
  /** The person's event. For a date with no time, local midnight of that date. */
  eventAt: Date | null;
  hasTime: boolean;
  now: Date;
  random: () => number;
}

const plus = (date: Date, ms: number) => new Date(date.getTime() + ms);

export function planWindows(input: WindowInput): Windows | null {
  const { kind, importance, eventAt, hasTime, now, random } = input;

  if (kind === "reminder") {
    // A reminder is a promise about a time. No jitter, no silence rule.
    if (!eventAt || !hasTime || eventAt.getTime() <= now.getTime()) return null;
    return { windowStart: eventAt, windowEnd: plus(eventAt, 12 * HOUR), pingAt: eventAt };
  }

  if (!eventAt) {
    // "Sometime soon": worth asking about if they come by, never worth a ping.
    return { windowStart: plus(now, 20 * HOUR), windowEnd: plus(now, 7 * 24 * HOUR), pingAt: null };
  }

  if (hasTime) {
    // Already well in the past: there is nothing left to follow up on.
    if (eventAt.getTime() < now.getTime() - 12 * HOUR) return null;
    // Give the thing an hour to actually happen before asking how it went.
    const windowStart = plus(eventAt, HOUR);
    const pingAt = importance === 3 ? plus(windowStart, (30 + random() * 60) * MINUTE)
      : importance === 2 ? plus(windowStart, (180 + random() * 60) * MINUTE)
      : null;
    return { windowStart, windowEnd: plus(windowStart, 48 * HOUR), pingAt };
  }

  // A day with no time: ask from that evening; only something that matters
  // earns a message the next morning.
  if (eventAt.getTime() < now.getTime() - 36 * HOUR) return null;
  const windowStart = plus(eventAt, 20 * HOUR);
  return {
    windowStart,
    windowEnd: plus(windowStart, 48 * HOUR),
    pingAt: importance === 3 ? plus(eventAt, 34 * HOUR + random() * 60 * MINUTE) : null,
  };
}

/**
 * What a pending ping becomes when the person writes first.
 *
 * Any message from them absorbs planned initiative: she can raise it in the
 * conversation they started, so she must not also write twenty minutes later.
 * Only a follow-up that really matters keeps a ping, pushed out past a full
 * silence, in case the conversation never got near it.
 */
export function pingAfterUserMessage(input: {
  kind: AgendaKind; importance: number; windowStart: Date; windowEnd: Date; pingAt: Date | null;
  now: Date; initiative: Initiative;
}): Date | null {
  const { kind, importance, windowStart, windowEnd, pingAt, now, initiative } = input;
  if (kind === "reminder" || !pingAt) return pingAt;
  if (kind === "initiative") return null;
  // Its moment has not come yet; this conversation is about something else.
  if (windowStart.getTime() > now.getTime()) return pingAt;
  if (importance < 3 || initiative === "off") return null;
  const pushed = new Date(Math.max(pingAt.getTime(), now.getTime() + SILENCE_HOURS[initiative] * HOUR));
  return pushed.getTime() <= windowEnd.getTime() ? pushed : null;
}

export function dedupeKey(kind: AgendaKind, about: string): string {
  const words = about.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return `${kind}:${words.slice(0, 8).join(" ")}`;
}
