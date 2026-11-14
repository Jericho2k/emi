import type { Db } from "../../db";
import type { AgendaItem, AgendaKind, AgendaStatus, User } from "../types";
import { dedupeKey, pingAfterUserMessage, type Windows } from "./policy";

type Row = Record<string, any>;

const toDate = (value: unknown): Date | null => (value == null ? null : value instanceof Date ? value : new Date(String(value)));

export function agendaFromRow(row: Row): AgendaItem {
  return {
    id: row.id, userId: row.user_id, kind: row.kind, about: row.about, reason: row.reason,
    importance: row.importance, eventAt: toDate(row.event_at), windowStart: toDate(row.window_start)!,
    windowEnd: toDate(row.window_end)!, pingAt: toDate(row.ping_at), closesWhen: row.closes_when,
    status: row.status, attempts: row.attempts, pingedAt: toDate(row.pinged_at), spontaneous: !!row.spontaneous, createdAt: toDate(row.created_at)!,
  };
}

export interface NewAgendaItem extends Windows {
  userId: string;
  kind: AgendaKind;
  about: string;
  reason?: string;
  importance: 1 | 2 | 3;
  eventAt?: Date | null;
  closesWhen?: string;
  sourceMessageId?: number | null;
  spontaneous?: boolean;
  at: Date;
}

/** One pending item per subject: mentioning the interview twice refreshes it. */
export async function upsertAgendaItem(db: Db, input: NewAgendaItem): Promise<AgendaItem> {
  const { rows } = await db.query<Row>(
    `insert into agenda_items (user_id, kind, about, reason, importance, event_at, window_start, window_end, ping_at, closes_when, dedupe_key, source_message_id, created_at, updated_at, spontaneous)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13, $14)
     on conflict (user_id, dedupe_key) where status = 'pending' do update set
       about = excluded.about, reason = excluded.reason, importance = excluded.importance, event_at = excluded.event_at,
       window_start = excluded.window_start, window_end = excluded.window_end, ping_at = excluded.ping_at,
       closes_when = excluded.closes_when, updated_at = excluded.updated_at, spontaneous = excluded.spontaneous
     returning *`,
    [input.userId, input.kind, input.about, input.reason ?? "", input.importance, input.eventAt ?? null, input.windowStart,
      input.windowEnd, input.pingAt, input.closesWhen ?? "", dedupeKey(input.kind, input.about), input.sourceMessageId ?? null, input.at, input.spontaneous ?? false],
  );
  return agendaFromRow(rows[0]!);
}

export async function pendingItems(db: Db, userId: string): Promise<AgendaItem[]> {
  const { rows } = await db.query<Row>(
    "select * from agenda_items where user_id = $1 and status = 'pending' order by window_start asc", [userId],
  );
  return rows.map(agendaFromRow);
}

/** After being offered once, an item waits this long before it is offered again. */
export const OFFER_COOLDOWN_MS = 12 * 3_600_000;

/** What she may bring up in a conversation the person started. */
export async function openForWeave(db: Db, userId: string, now: Date, limit = 3): Promise<AgendaItem[]> {
  const { rows } = await db.query<Row>(
    `select * from agenda_items where user_id = $1 and status = 'pending' and kind <> 'reminder'
        and window_start <= $2 and window_end >= $2
        and (offered_at is null or offered_at < $4)
      order by importance desc, window_start asc limit $3`,
    [userId, now, limit, new Date(now.getTime() - OFFER_COOLDOWN_MS)],
  );
  // Whether or not she takes one up, they are not offered again this conversation.
  if (rows.length) await db.query("update agenda_items set offered_at = $2 where id = any($1::uuid[])", [rows.map((row) => row.id), now]);
  return rows.map(agendaFromRow);
}

export async function setStatus(db: Db, id: string, status: AgendaStatus, note: string, now: Date): Promise<void> {
  await db.query(
    `update agenda_items set status = $2, resolution_note = $3, updated_at = $4,
        ping_at = case when $2 = 'pending' then ping_at else null end,
        pinged_at = case when $2 = 'pinged' then $4 else pinged_at end,
        attempts = attempts + case when $2 = 'pinged' then 1 else 0 end
      where id = $1`,
    [id, status, note.slice(0, 300), now],
  );
}

export async function setPing(db: Db, id: string, pingAt: Date | null, now: Date): Promise<void> {
  await db.query("update agenda_items set ping_at = $2, updated_at = $3 where id = $1", [id, pingAt, now]);
}

/** Applies "they wrote first" to every pending ping. See pingAfterUserMessage. */
export async function absorbOnUserMessage(db: Db, user: User, now: Date): Promise<void> {
  for (const item of await pendingItems(db, user.id)) {
    const next = pingAfterUserMessage({ ...item, now, initiative: user.initiative });
    if ((next?.getTime() ?? null) !== (item.pingAt?.getTime() ?? null)) await setPing(db, item.id, next, now);
  }
}

export async function expireStale(db: Db, now: Date): Promise<number> {
  const { rows } = await db.query(
    "update agenda_items set status = 'expired', ping_at = null, updated_at = $1 where status = 'pending' and window_end < $1 returning id", [now],
  );
  // A check-in nobody answered within a day is simply over. No penalty.
  await db.query(
    "update agenda_items set status = 'done', updated_at = $1 where status = 'pinged' and pinged_at < $2",
    [now, new Date(now.getTime() - 24 * 3_600_000)],
  );
  return rows.length;
}

/**
 * Takes due pings and leases them for ten minutes, so a second worker, or a
 * crash halfway through, can neither double-send nor lose one.
 */
export async function claimDuePings(db: Db, now: Date, limit = 20): Promise<AgendaItem[]> {
  const lease = new Date(now.getTime() + 10 * 60_000);
  const { rows } = await db.query<Row>(
    `with due as (
       select id, ping_at as due_at from agenda_items
        where status = 'pending' and ping_at <= $1 order by ping_at limit $3 for update skip locked
     )
     update agenda_items a set ping_at = $2, updated_at = $1
       from due where a.id = due.id returning a.*, due.due_at`,
    [now, lease, limit],
  );
  return rows.map((row) => ({ ...agendaFromRow(row), pingAt: toDate(row.due_at) }));
}

/** The check-in they are most plausibly answering right now, if any. */
export async function awaitingReaction(db: Db, userId: string, now: Date): Promise<AgendaItem | null> {
  const { rows } = await db.query<Row>(
    "select * from agenda_items where user_id = $1 and status = 'pinged' and pinged_at >= $2 order by pinged_at desc limit 1",
    [userId, new Date(now.getTime() - 12 * 3_600_000)],
  );
  return rows[0] ? agendaFromRow(rows[0]) : null;
}

export async function hasOpenInitiative(db: Db, userId: string, now: Date): Promise<boolean> {
  const { rows } = await db.query(
    `select 1 from agenda_items where user_id = $1 and status = 'pending' and kind <> 'reminder'
        and window_start <= $2 and window_end >= $3 limit 1`,
    [userId, new Date(now.getTime() + 24 * 3_600_000), now],
  );
  return rows.length > 0;
}
