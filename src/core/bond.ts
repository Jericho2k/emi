import type { Db } from "../db";
import { describeDay, describeGap, isValidTimeZone } from "./clock";
import type { Bond, User } from "./types";

/**
 * HOW CLOSE THEY ARE.
 *
 * Closeness is never a number a model sets. It comes from what actually
 * happened: on how many different days they talked, how much, and how much
 * of their life she knows. Warmth and trust only tilt it, and move in small,
 * bounded steps after each exchange, so one sweet or one rude message cannot
 * swing the relationship.
 *
 * Irritation is the one fast signal. It rises when she is treated badly and
 * fades on its own within hours. It changes her tone and whether she writes
 * first, never whether or how well she helps.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const DEFAULT_WARMTH = 0.5;
export const DEFAULT_TRUST = 0.4;
/** Irritation halves every this many hours. */
export const IRRITATION_HALF_LIFE_HOURS = 4;
/** Per exchange, at most. */
export const WARMTH_STEP = 0.03;
export const TRUST_STEP = 0.03;
export const IRRITATION_RISE = 0.35;

const clamp = (value: number) => Math.min(1, Math.max(0, value));

/** Irritation as it is now, after fading since it was last set. */
export function currentIrritation(bond: Bond, now: Date): number {
  const value = bond.irritation ?? 0;
  if (!value || !bond.irritationAt) return value;
  const hours = Math.max(0, (now.getTime() - new Date(bond.irritationAt).getTime()) / HOUR);
  const faded = value * 0.5 ** (hours / IRRITATION_HALF_LIFE_HOURS);
  return faded < 0.02 ? 0 : faded;
}

export type Signal = -1 | 0 | 1;
export interface BondSignals {
  warmth?: Signal;
  trust?: Signal;
  irritation?: Signal;
  reason?: string;
}

/** One exchange's worth of change. The model gives a direction; the size is fixed here. */
export function applySignals(bond: Bond, signals: BondSignals, now: Date): Bond {
  const next: Bond = {
    ...bond,
    warmth: clamp((bond.warmth ?? DEFAULT_WARMTH) + WARMTH_STEP * (signals.warmth ?? 0)),
    trust: clamp((bond.trust ?? DEFAULT_TRUST) + TRUST_STEP * (signals.trust ?? 0)),
  };
  const irritation = currentIrritation(bond, now);
  if (signals.irritation === 1) {
    next.irritation = clamp(irritation + IRRITATION_RISE);
    next.irritationAt = now.toISOString();
    next.irritationReason = signals.reason?.slice(0, 80) || bond.irritationReason;
  } else if (signals.irritation === -1 && irritation > 0) {
    // They made up: most of it goes at once.
    next.irritation = irritation * 0.3;
    next.irritationAt = now.toISOString();
  }
  return next;
}

export interface Familiarity {
  /** Distinct days, on their calendar, on which they wrote. */
  activeDays: number;
  userMessages: number;
  /** Everything she holds about them and about the two of them. */
  memories: number;
  firstMessageAt: Date | null;
}

const saturate = (value: number, scale: number) => 1 - Math.exp(-value / scale);

/**
 * 0..1. Mostly "how many days have we talked", because a relationship is
 * built over days, not in one long night of messages.
 */
export function familiarity(f: Familiarity): number {
  return clamp(0.6 * saturate(f.activeDays, 14) + 0.25 * saturate(f.userMessages, 300) + 0.15 * saturate(f.memories, 25));
}

export function closeness(f: Familiarity, bond: Bond): number {
  const feeling = ((bond.warmth ?? DEFAULT_WARMTH) + (bond.trust ?? DEFAULT_TRUST)) / 2;
  // Neutral feeling leaves familiarity as it is; warmth and trust can stretch
  // it by half either way.
  return clamp(familiarity(f) * (0.5 + feeling + 0.05));
}

export interface Stage {
  index: number;
  name: string;
  /** Lowest closeness that reaches this stage. */
  from: number;
  /** How it changes the way she talks. Tone only, never availability. */
  guidance: string;
}

export const STAGES: Stage[] = [
  { index: 0, name: "just met", from: 0,
    guidance: "You're still getting a sense of each other. Friendly and curious about them, light humour, a bit reserved about yourself. No pet names, no in-jokes you don't have yet, no acting like old friends." },
  { index: 1, name: "getting to know each other", from: 0.12,
    guidance: "You've started to know each other. More relaxed, you tease a little when they give you an opening, you bring back things they told you, and you share some of what's on your mind." },
  { index: 2, name: "friends", from: 0.3,
    guidance: "You're friends. Tease freely, disagree honestly, share what's on your mind without being asked, and use your running jokes when they fit." },
  { index: 3, name: "close", from: 0.55,
    guidance: "You're close. Comfortable and affectionate in your own dry way, open about your moods, you use what you call each other, and you're visibly glad when they turn up." },
  { index: 4, name: "very close", from: 0.78,
    guidance: "You go way back. Shorthand and callbacks, you can be blunt because there's trust, and you say you care when it's true. Never clingy." },
];

export function stageFor(value: number): Stage {
  return [...STAGES].reverse().find((stage) => value >= stage.from) ?? STAGES[0]!;
}

export interface BondSnapshot {
  familiarity: Familiarity;
  closeness: number;
  stage: Stage;
  irritation: number;
  irritationReason?: string;
}

export async function familiarityOf(db: Db, user: User): Promise<Familiarity> {
  const tz = isValidTimeZone(user.timezone) ? user.timezone : "UTC";
  const { rows: [talk] } = await db.query<{ days: string; n: string; first: Date | string | null }>(
    `select count(distinct (created_at at time zone $2)::date) as days, count(*) as n, min(created_at) as first
       from messages where user_id = $1 and role = 'user' and kind <> 'command'`,
    [user.id, tz],
  );
  const { rows: [held] } = await db.query<{ n: string }>(
    "select count(*) as n from memories where user_id = $1 and status = 'active'", [user.id],
  );
  return {
    activeDays: Number(talk?.days ?? 0),
    userMessages: Number(talk?.n ?? 0),
    memories: Number(held?.n ?? 0),
    firstMessageAt: talk?.first ? new Date(talk.first) : null,
  };
}

export async function bondSnapshot(db: Db, user: User, now: Date): Promise<BondSnapshot> {
  const f = await familiarityOf(db, user);
  const value = closeness(f, user.bond);
  return { familiarity: f, closeness: value, stage: stageFor(value), irritation: currentIrritation(user.bond, now), irritationReason: user.bond.irritationReason };
}

/** At or above this, she does not write first until it has faded. */
export const IRRITATION_HOLDS_INITIATIVE = 0.5;
/** After this long without them, a friend would notice. */
const ABSENCE_NOTICED = 3 * DAY;

/** The lines about the two of them that go into her private notes. */
export function bondLines(snapshot: BondSnapshot, user: User, now: Date, previousUserAt: Date | null): string[] {
  const { stage, familiarity: f } = snapshot;
  const since = f.firstMessageAt ? ` since ${describeDay(f.firstMessageAt, user.timezone)}` : "";
  const days = f.activeDays > 1 ? ` You've talked on ${f.activeDays} different days${since}.` : "";
  const lines = [`How close you two are: ${stage.name}.${days} ${stage.guidance}`];

  if (snapshot.irritation >= IRRITATION_HOLDS_INITIATIVE) {
    lines.push(`You're properly annoyed with them${snapshot.irritationReason ? ` (${snapshot.irritationReason})` : ""}. You can say so plainly, once. Shorter and drier is fine. You still help fully and well with anything they ask.`);
  } else if (snapshot.irritation >= 0.2) {
    lines.push(`You're still a little put out${snapshot.irritationReason ? ` (${snapshot.irritationReason})` : ""}. It shows only as a slightly drier tone, and it's fading. Don't bring it up again.`);
  }

  if (previousUserAt && stage.index >= 2 && now.getTime() - previousUserAt.getTime() >= ABSENCE_NOTICED) {
    lines.push(`They've been away ${describeGap(now.getTime() - previousUserAt.getTime())}. You'd notice: if it fits, say something light about it and be glad they're back. Never guilt them for being away.`);
  }
  return lines;
}
