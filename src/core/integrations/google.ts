import type { Db } from "../../db";
import { accessToken, api, type IntegrationsConfig } from "./connect";

/**
 * Google Calendar (primary calendar) and Google Tasks (default list), behind
 * one sign-in. Times are written as local wall time with the person's
 * timezone, so Google does the conversion. Events never get attendees, so
 * nothing she does can send an invitation to anyone.
 */

const CALENDAR = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const TASKS = "https://tasks.googleapis.com/tasks/v1/lists/@default/tasks";

export interface CalendarEvent { id: string; title: string; start: string; end: string; allDay: boolean }
export interface Task { id: string; title: string; due: string | null; notes: string }

interface GoogleTime { dateTime?: string; date?: string }
interface GoogleEvent { id: string; summary?: string; start?: GoogleTime; end?: GoogleTime; status?: string }
interface GoogleTask { id: string; title?: string; due?: string; notes?: string; status?: string }

export interface GoogleClient {
  events(from: Date, to: Date): Promise<CalendarEvent[]>;
  addEvent(input: { title: string; start: string; end: string; allDay: boolean; note?: string }): Promise<CalendarEvent>;
  moveEvent(id: string, start: string, end: string, allDay: boolean): Promise<void>;
  removeEvent(id: string): Promise<void>;
  tasks(): Promise<Task[]>;
  addTask(input: { title: string; due?: string | null; note?: string }): Promise<Task>;
  completeTask(id: string): Promise<void>;
  removeTask(id: string): Promise<void>;
}

/** "2026-11-20T10:30" or "2026-11-20", as Google's time object in their timezone. */
function googleTime(local: string, allDay: boolean, timeZone: string): GoogleTime {
  return allDay ? { date: local.slice(0, 10) } : { dateTime: `${local.slice(0, 16)}:00`, timeZone } as GoogleTime;
}

const shown = (time: GoogleTime | undefined) => (time?.dateTime ?? time?.date ?? "").slice(0, 16);

export function google(db: Db, config: IntegrationsConfig, userId: string, timeZone: string, now: () => Date): GoogleClient {
  const call = async <T>(method: string, url: string, body?: unknown) =>
    api<T>(config, await accessToken(db, config, userId, "google", now()), method, url, body);
  const event = (item: GoogleEvent): CalendarEvent => ({
    id: item.id, title: item.summary ?? "(no title)", start: shown(item.start), end: shown(item.end), allDay: !!item.start?.date,
  });
  return {
    async events(from, to) {
      const params = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "25", timeZone });
      const data = await call<{ items?: GoogleEvent[] }>("GET", `${CALENDAR}?${params}`);
      return (data.items ?? []).filter((item) => item.status !== "cancelled").map(event);
    },
    async addEvent({ title, start, end, allDay, note }) {
      const created = await call<GoogleEvent>("POST", CALENDAR, {
        summary: title, ...(note ? { description: note } : {}),
        start: googleTime(start, allDay, timeZone), end: googleTime(end, allDay, timeZone),
      });
      return event(created);
    },
    async moveEvent(id, start, end, allDay) {
      await call("PATCH", `${CALENDAR}/${encodeURIComponent(id)}`, { start: googleTime(start, allDay, timeZone), end: googleTime(end, allDay, timeZone) });
    },
    async removeEvent(id) {
      await call("DELETE", `${CALENDAR}/${encodeURIComponent(id)}`);
    },
    async tasks() {
      const data = await call<{ items?: GoogleTask[] }>("GET", `${TASKS}?${new URLSearchParams({ showCompleted: "false", maxResults: "25" })}`);
      return (data.items ?? []).filter((item) => item.status !== "completed" && item.title?.trim())
        .map((item) => ({ id: item.id, title: item.title!.trim(), due: item.due ? item.due.slice(0, 10) : null, notes: item.notes ?? "" }));
    },
    async addTask({ title, due, note }) {
      const created = await call<GoogleTask>("POST", TASKS, { title, ...(note ? { notes: note } : {}), ...(due ? { due: `${due.slice(0, 10)}T00:00:00.000Z` } : {}) });
      return { id: created.id, title, due: due ?? null, notes: note ?? "" };
    },
    async completeTask(id) {
      await call("PATCH", `${TASKS}/${encodeURIComponent(id)}`, { status: "completed" });
    },
    async removeTask(id) {
      await call("DELETE", `${TASKS}/${encodeURIComponent(id)}`);
    },
  };
}
