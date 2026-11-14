import type { ImageMime } from "./images";
import type { Db } from "../db";

/**
 * Everything Emi holds about a person, and the way to erase it. Independent
 * of the chat channel.
 */

export interface AccountExport {
  exportedAt: string;
  settings: Record<string, unknown>;
  memories: unknown[];
  agenda: unknown[];
  timeline: { arcs: unknown[]; entries: unknown[] };
  messages: unknown[];
  images: Array<{ id: string; message_id: number; position: number; mime_type: ImageMime; origin: "reply" | null; byte_size: number }>;
}

/** Archive manifest. The channel exports original images via the scoped loader. */
export async function exportAccount(db: Db, userId: string, now: Date): Promise<AccountExport> {
  const one = async (sql: string) => (await db.query(sql, [userId])).rows;
  const [settings] = await one(
    "select display_name, timezone, timezone_known, initiative, quiet_start, quiet_end, daily_cap_usd, mood, created_at from users where id = $1",
  );
  return {
    exportedAt: now.toISOString(),
    settings: settings ?? {},
    // Superseded memories are part of the record; erased ones hold no text.
    memories: await one(
      "select id, kind, content, status, pinned, source, evidence, occurred_on, storyline, superseded_by, created_at from memories where user_id = $1 and status <> 'deleted' order by created_at",
    ),
    agenda: await one(
      "select kind, about, reason, importance, event_at, window_start, window_end, ping_at, status, resolution_note, created_at from agenda_items where user_id = $1 order by created_at",
    ),
    timeline: {
      arcs: await one("select started_at, ended_at, headline, summary from arcs where user_id = $1 order by end_message_id"),
      entries: await one("select level, started_at, ended_at, summary from timeline_entries where user_id = $1 order by level desc, end_message_id"),
    },
    images: (await db.query<AccountExport["images"][number]>(`select i.id, i.message_id, i.position, i.mime_type, i.origin, octet_length(i.data) as byte_size
      from message_images i join messages m on m.id = i.message_id where m.user_id = $1 order by m.id, i.position`, [userId])).rows,
    messages: await one("select id, role, kind, content, reply_context, created_at from messages where user_id = $1 order by id"),
  };
}

/**
 * Erases the conversation and everything learned from it. Settings, the API
 * key and the usage ledger stay, so the person can simply start again.
 */
export async function wipeAccount(db: Db, userId: string): Promise<void> {
  for (const table of ["agenda_items", "timeline_entries", "arcs", "memories", "messages"]) {
    await db.query(`delete from ${table} where user_id = $1`, [userId]);
  }
  await db.query(
    `update users set mood = '{}'::jsonb, brushoff_count = 0, extracted_through = 0, consolidated_through = 0,
       last_user_message_at = null, last_emi_message_at = null, last_planned_on = null where id = $1`,
    [userId],
  );
}
