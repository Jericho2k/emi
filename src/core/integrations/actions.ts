import { z } from "zod";
import type { Db } from "../../db";
import { describeDay } from "../clock";
import type { Deps, User } from "../types";
import { configured, connectedProviders, IntegrationError, type IntegrationsConfig, type Provider } from "./connect";
import { google, type CalendarEvent, type Task } from "./google";
import { makePlaylist } from "./spotify";

/**
 * WHAT SHE CAN DO IN THEIR ACCOUNTS.
 *
 * She sees their week and their to-dos in her notes, each with a short id,
 * and acts by writing <<do:{...}>> lines. Code does everything else: resolves
 * ids (she cannot invent one), checks each action against their autonomy
 * setting, runs it or holds it for their OK, and records the playful ones so
 * they are undone when she makes up. Nothing here can reach another person:
 * events get no attendees and playlists are private.
 */

export type Autonomy = "ask" | "normal" | "auto";
export const AUTONOMY_LEVELS: Autonomy[] = ["ask", "normal", "auto"];

const local = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/);
const title = z.string().trim().min(1).max(120);
const label = z.string().trim().regex(/^[et]\d{1,2}$/i);
const gesture = z.boolean().optional();

export const ActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("event.add"), title, start: local, end: local.optional(), note: z.string().max(300).optional(), gesture }),
  z.object({ type: z.literal("event.move"), id: label, start: local, end: local.optional(), gesture }),
  z.object({ type: z.literal("event.remove"), id: label, gesture }),
  z.object({ type: z.literal("task.add"), title, due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), note: z.string().max(300).optional(), gesture }),
  z.object({ type: z.literal("task.done"), id: label, gesture }),
  z.object({ type: z.literal("task.remove"), id: label, gesture }),
  z.object({ type: z.literal("playlist.make"), title, songs: z.array(z.string().trim().min(2).max(120)).min(2).max(25), note: z.string().max(300).optional(), gesture }),
]);
export type Action = z.infer<typeof ActionSchema>;

// Any do-tag is removed from what they see, well-formed or not.
const ACTION_TAG = /<<\s*do\s*:([\s\S]*?)>>/gi;
const MAX_ACTIONS = 3;

/** Pulls <<do:{...}>> lines out of a reply. Malformed ones are dropped, never shown. */
export function extractActions(text: string): { text: string; actions: Action[] } {
  const actions: Action[] = [];
  const rest = text.replace(ACTION_TAG, (_, json: string) => {
    try {
      const parsed = ActionSchema.safeParse(JSON.parse(json.trim()));
      if (parsed.success && actions.length < MAX_ACTIONS) actions.push(parsed.data);
    } catch { /* not JSON: dropped */ }
    return "";
  });
  return { text: rest, actions };
}

/** What a short id in her notes stands for. */
export type Labelled =
  | { kind: "event"; id: string; event: CalendarEvent }
  | { kind: "task"; id: string; task: Task };

export interface View {
  lines: string[];
  labels: Map<string, Labelled>;
  providers: Provider[];
}

const cache = new Map<string, { at: number; view: View }>();
const CACHE_MS = 90_000;

export function forgetView(userId: string): void {
  cache.delete(userId);
}

function when(event: CalendarEvent, tz: string): string {
  if (event.allDay) return `${event.start.slice(0, 10)} (all day)`;
  const day = describeDay(new Date(`${event.start}:00Z`), "UTC");
  return `${day} ${event.start.slice(11, 16)}–${event.end.slice(11, 16)}`;
}

/** Their week and their to-dos, with short ids, for her notes. Errors become a plain line. */
export async function integrationView(deps: Deps, user: User, now: Date): Promise<View> {
  const config = deps.integrations;
  const empty: View = { lines: [], labels: new Map(), providers: [] };
  if (!config || (!configured(config, "google") && !configured(config, "spotify"))) return empty;
  const hit = cache.get(user.id);
  if (hit && now.getTime() - hit.at < CACHE_MS) return hit.view;

  const providers = await connectedProviders(deps.db, user.id);
  const lines: string[] = [];
  const labels = new Map<string, Labelled>();
  if (providers.includes("google")) {
    const client = google(deps.db, config, user.id, user.timezone, deps.clock);
    try {
      const [events, tasks] = await Promise.all([client.events(now, new Date(now.getTime() + 7 * 86_400_000)), client.tasks()]);
      lines.push("Their calendar, next 7 days, in their time:", ...(events.length ? events.slice(0, 20).map((event, index) => {
        labels.set(`e${index + 1}`, { kind: "event", id: event.id, event });
        return `- e${index + 1}: ${when(event, user.timezone)} ${event.title}`;
      }) : ["(nothing)"]));
      lines.push("Their open to-dos:", ...(tasks.length ? tasks.slice(0, 20).map((task, index) => {
        labels.set(`t${index + 1}`, { kind: "task", id: task.id, task });
        return `- t${index + 1}: ${task.title}${task.due ? ` (due ${task.due})` : ""}`;
      }) : ["(none)"]));
    } catch (error) {
      lines.push(error instanceof IntegrationError && error.lost
        ? "Their Google connection stopped working. If it comes up, they can reconnect with /connect google."
        : "Their calendar and to-dos couldn't be loaded just now.");
    }
  } else if (configured(config, "google")) {
    lines.push("Their calendar and to-dos aren't connected. If they want you to handle them, they can send /connect google.");
  }
  if (!providers.includes("spotify") && configured(config, "spotify")) {
    lines.push("Spotify isn't connected (/connect spotify). For a playlist until then, send song links instead.");
  }
  const view = { lines, labels, providers };
  cache.set(user.id, { at: now.getTime(), view });
  return view;
}

const changes = new Set<Action["type"]>(["event.move", "event.remove", "task.remove"]);
const adds = new Set<Action["type"]>(["event.add", "task.add", "playlist.make"]);

export function needsOk(action: Action, autonomy: Autonomy): boolean {
  if (autonomy === "auto") return false;
  if (autonomy === "ask") return true;
  return changes.has(action.type);
}

/** What autonomy means, for her notes. */
export function autonomyLine(autonomy: Autonomy): string {
  return autonomy === "ask" ? "Every change you make waits for their OK: the app shows them buttons, so say what you're about to do, never that it's done."
    : autonomy === "auto" ? "You can make changes without asking."
      : "Adding things and ticking off to-dos just happen. Moving or removing anything waits for their OK: the app shows them buttons, so for those say what you're about to do, never that it's done.";
}

export interface Resolved {
  action: Action;
  /** The real id behind a short one, for moves and removals. */
  target?: Labelled;
  /** Unasked and playful; undone later if she did it while annoyed. */
  gesture: boolean;
}

/**
 * Turns what she wrote into what may happen. Unknown ids, actions on accounts
 * that aren't connected, and gestures she isn't allowed right now are dropped.
 */
export function resolveActions(actions: Action[], view: View, opts: { gestures: boolean }): Resolved[] {
  const out: Resolved[] = [];
  for (const action of actions) {
    const isGesture = "gesture" in action && !!action.gesture;
    if (isGesture && (!opts.gestures || !adds.has(action.type))) continue;
    if (action.type === "playlist.make" ? !view.providers.includes("spotify") : !view.providers.includes("google")) continue;
    if ("id" in action) {
      const target = view.labels.get(action.id.toLowerCase());
      const kind = action.type.startsWith("event") ? "event" : "task";
      if (!target || target.kind !== kind) continue;
      out.push({ action, target, gesture: false });
    } else out.push({ action, gesture: isGesture });
  }
  return out;
}

const pretty = (localTime: string, tz: string) => {
  const allDay = localTime.length === 10;
  const day = describeDay(new Date(`${localTime.slice(0, 10)}T12:00:00Z`), "UTC");
  return allDay ? day : `${day} ${localTime.slice(11, 16)}`;
};

function addMinutes(localTime: string, minutes: number): string {
  const date = new Date(`${localTime}:00Z`);
  return new Date(date.getTime() + minutes * 60_000).toISOString().slice(0, 16);
}

function nextDay(day: string): string {
  return new Date(new Date(`${day}T12:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);
}

/** One line saying what the action is, for buttons, results and her history. */
export function describeAction(resolved: Resolved, tz: string): string {
  const { action, target } = resolved;
  switch (action.type) {
    case "event.add": return `📅 add "${action.title}", ${pretty(action.start, tz)}`;
    case "event.move": return `📅 move "${target?.kind === "event" ? target.event.title : action.id}" to ${pretty(action.start, tz)}`;
    case "event.remove": return `📅 remove "${target?.kind === "event" ? target.event.title : action.id}"`;
    case "task.add": return `📝 add to-do "${action.title}"${action.due ? ` (due ${action.due})` : ""}`;
    case "task.done": return `✅ tick off "${target?.kind === "task" ? target.task.title : action.id}"`;
    case "task.remove": return `📝 remove to-do "${target?.kind === "task" ? target.task.title : action.id}"`;
    case "playlist.make": return `🎵 make playlist "${action.title}" (${action.songs.length} songs)`;
  }
}

export interface Outcome {
  ok: boolean;
  /** Shown to them and kept in her history. */
  text: string;
  /** For gestures done while annoyed: what to delete when she makes up. */
  undo?: { kind: "event" | "task"; id: string };
}

/** Does one action. Failures come back as a plain sentence, never thrown. */
export async function runAction(db: Db, config: IntegrationsConfig, user: User, resolved: Resolved, now: () => Date): Promise<Outcome> {
  const { action, target } = resolved;
  const done = describeAction(resolved, user.timezone).replace(/^(\S+) (\w+)/, (_, icon: string, verb: string) => `${icon} ${pastTense(verb)}`);
  try {
    const client = google(db, config, user.id, user.timezone, now);
    switch (action.type) {
      case "event.add": {
        const allDay = action.start.length === 10;
        const end = action.end && action.end > action.start ? action.end : allDay ? nextDay(action.start) : addMinutes(action.start, 60);
        const event = await client.addEvent({ title: action.title, start: action.start, end, allDay, note: action.note });
        return { ok: true, text: done, undo: { kind: "event", id: event.id } };
      }
      case "event.move": {
        if (target?.kind !== "event") break;
        const allDay = action.start.length === 10;
        const length = target.event.allDay ? 0 : Math.max(15, (new Date(`${target.event.end}:00Z`).getTime() - new Date(`${target.event.start}:00Z`).getTime()) / 60_000);
        const end = action.end && action.end > action.start ? action.end : allDay ? nextDay(action.start) : addMinutes(action.start, length || 60);
        await client.moveEvent(target.id, action.start, end, allDay);
        return { ok: true, text: done };
      }
      case "event.remove":
        if (target?.kind !== "event") break;
        await client.removeEvent(target.id);
        return { ok: true, text: done };
      case "task.add": {
        const task = await client.addTask({ title: action.title, due: action.due, note: action.note });
        return { ok: true, text: done, undo: { kind: "task", id: task.id } };
      }
      case "task.done":
        if (target?.kind !== "task") break;
        await client.completeTask(target.id);
        return { ok: true, text: done };
      case "task.remove":
        if (target?.kind !== "task") break;
        await client.removeTask(target.id);
        return { ok: true, text: done };
      case "playlist.make": {
        const playlist = await makePlaylist(db, config, user.id, now(), action.title, action.songs, action.note);
        return { ok: true, text: `🎵 made "${action.title}" (${playlist.found} songs): ${playlist.url}` };
      }
    }
    return { ok: false, text: `couldn't ${describeAction(resolved, user.timezone).replace(/^\S+ /, "")}: it's not there anymore` };
  } catch (error) {
    const why = error instanceof IntegrationError && error.lost ? "the connection needs /connect again" : "the service didn't accept it";
    console.warn("[action]", action.type, error instanceof Error ? error.message : error);
    return { ok: false, text: `couldn't ${describeAction(resolved, user.timezone).replace(/^\S+ /, "")}: ${why}` };
  } finally {
    forgetView(user.id);
  }
}

function pastTense(verb: string): string {
  return ({ add: "added", move: "moved", remove: "removed", tick: "ticked", make: "made" } as Record<string, string>)[verb] ?? verb;
}

/** Holds an action for their OK, behind a button. */
export async function holdAction(db: Db, userId: string, resolved: Resolved, summary: string, now: Date): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "insert into pending_actions (user_id, action, summary, created_at) values ($1, $2::jsonb, $3, $4) returning id",
    [userId, JSON.stringify(resolved), summary, now],
  );
  return rows[0]!.id;
}

/** Takes a held action for running, once. Stale or already decided ones come back null. */
export async function claimHeld(db: Db, userId: string, id: string, decision: "done" | "declined", now: Date): Promise<{ resolved: Resolved; summary: string } | null> {
  const { rows } = await db.query<{ action: unknown; summary: string }>(
    `update pending_actions set status = $4, decided_at = $3
      where id = $1 and user_id = $2 and status = 'pending' and created_at > $3::timestamptz - interval '1 day'
      returning action, summary`,
    [id, userId, now, decision],
  );
  const row = rows[0];
  if (!row) return null;
  const resolved = (typeof row.action === "string" ? JSON.parse(row.action) : row.action) as Resolved;
  return { resolved, summary: row.summary };
}

export async function markHeld(db: Db, id: string, status: "done" | "failed"): Promise<void> {
  await db.query("update pending_actions set status = $2 where id = $1", [id, status]);
}

/** Deletes what a gesture made, when she makes up. */
export async function undoGesture(deps: Deps, user: User, undo: { kind: "event" | "task"; id: string }): Promise<void> {
  if (!deps.integrations) return;
  const client = google(deps.db, deps.integrations, user.id, user.timezone, deps.clock);
  if (undo.kind === "event") await client.removeEvent(undo.id);
  else await client.removeTask(undo.id);
  forgetView(user.id);
}
