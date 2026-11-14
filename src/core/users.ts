import type { Db } from "../db";
import type { Usage } from "../llm/provider";
import { IMAGE_REFERENCES_SQL, validateImages, type ImageInput } from "./images";
import { localParts, localToUtc } from "./clock";
import { INITIATIVE_LEVELS, type Initiative, type Mood, type ReplyContext, type StoredMessage, type User } from "./types";

type Row = Record<string, any>;

const toDate = (value: unknown): Date | null => (value == null ? null : value instanceof Date ? value : new Date(String(value)));

function dateKey(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

export function userFromRow(row: Row): User {
  return {
    id: row.id,
    displayName: row.display_name ?? null,
    timezone: row.timezone,
    timezoneKnown: row.timezone_known,
    initiative: row.initiative,
    brushoffCount: row.brushoff_count,
    quietStart: row.quiet_start,
    quietEnd: row.quiet_end,
    dailyCapUsd: Number(row.daily_cap_usd),
    mood: (typeof row.mood === "string" ? JSON.parse(row.mood) : row.mood) ?? {},
    encryptedApiKey: row.encrypted_api_key ?? null,
    lastUserMessageAt: toDate(row.last_user_message_at),
    lastEmiMessageAt: toDate(row.last_emi_message_at),
    extractedThrough: Number(row.extracted_through),
    consolidatedThrough: Number(row.consolidated_through ?? 0),
    lastPlannedOn: dateKey(row.last_planned_on),
    createdAt: toDate(row.created_at)!,
  };
}

export async function getUser(db: Db, id: string): Promise<User | null> {
  const { rows } = await db.query("select * from users where id = $1", [id]);
  return rows[0] ? userFromRow(rows[0]) : null;
}

/** Finds the person behind a channel identity, creating them on first contact. */
export async function userForChannel(db: Db, now: Date, input: { channel: string; externalId: string; chatId: string; displayName?: string | null }): Promise<User> {
  const found = await db.query<Row>(
    "select u.* from channel_identities c join users u on u.id = c.user_id where c.channel = $1 and c.external_id = $2",
    [input.channel, input.externalId],
  );
  if (found.rows[0]) return userFromRow(found.rows[0]);
  const created = await db.query<Row>(
    "insert into users (display_name, created_at) values ($1, $2) returning *",
    [input.displayName ?? null, now],
  );
  const user = userFromRow(created.rows[0]!);
  await db.query(
    "insert into channel_identities (channel, external_id, user_id, chat_id) values ($1, $2, $3, $4)",
    [input.channel, input.externalId, user.id, input.chatId],
  );
  return user;
}

export async function chatIdFor(db: Db, userId: string, channel: string): Promise<string | null> {
  const { rows } = await db.query<{ chat_id: string }>(
    "select chat_id from channel_identities where user_id = $1 and channel = $2 limit 1", [userId, channel],
  );
  return rows[0]?.chat_id ?? null;
}

const SETTABLE: Record<string, string> = {
  displayName: "display_name", timezone: "timezone", timezoneKnown: "timezone_known",
  initiative: "initiative", brushoffCount: "brushoff_count", quietStart: "quiet_start",
  quietEnd: "quiet_end", dailyCapUsd: "daily_cap_usd", encryptedApiKey: "encrypted_api_key",
  lastUserMessageAt: "last_user_message_at", lastEmiMessageAt: "last_emi_message_at",
  extractedThrough: "extracted_through", consolidatedThrough: "consolidated_through", lastPlannedOn: "last_planned_on",
};

export async function updateUser(db: Db, id: string, patch: Partial<Omit<User, "id" | "mood" | "createdAt">> & { mood?: Mood }): Promise<void> {
  const sets: string[] = [], params: unknown[] = [id];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (key === "mood") {
      params.push(JSON.stringify(value));
      sets.push(`mood = $${params.length}::jsonb`);
      continue;
    }
    const column = SETTABLE[key];
    if (!column) continue;
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  }
  if (sets.length) await db.query(`update users set ${sets.join(", ")} where id = $1`, params);
}

export function lowerInitiative(level: Initiative): Initiative {
  // A brush-off quietens her; it never switches her off. Only the person does that.
  if (level === "off" || level === "low") return level;
  return INITIATIVE_LEVELS[INITIATIVE_LEVELS.indexOf(level) - 1] ?? "low";
}

// ---- messages ----

function messageFromRow(row: Row): StoredMessage {
  return {
    id: Number(row.id), role: row.role, content: row.content, kind: row.kind,
    replyTo: row.reply_context ?? undefined,
    ...(row.images?.length ? { images: row.images } : {}),
    agendaItemId: row.agenda_item_id ?? null, createdAt: toDate(row.created_at)!,
  };
}

export async function addMessage(db: Db, input: { userId: string; role: "user" | "emi"; content: string; kind?: StoredMessage["kind"]; images?: ImageInput[]; replyTo?: ReplyContext; agendaItemId?: string | null; at: Date }): Promise<StoredMessage> {
  const images = input.images ?? [];
  validateImages(images);
  if (images.length && input.role !== "user") throw new Error("only incoming messages may attach images");
  // One statement makes the message and its images atomic on a pooled DB. A
  // picture already stored for this person is referenced, not copied; the
  // ownership check is part of the insert.
  const { rows } = await db.query<Row>(
    `with message as (
       insert into messages (user_id, role, content, kind, agenda_item_id, created_at, reply_context)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb) returning *
     ), images as (
       insert into message_images (message_id, position, mime_type, origin, data, source_key, source_image_id)
       select message.id, image.position, image.mime_type, image.origin,
         case when image.stored_id is null then decode(image.data, 'base64') end, image.source_key, owned.id
       from message cross join jsonb_to_recordset($8::jsonb) as image(position int, mime_type text, origin text, data text, source_key text, stored_id uuid)
       left join lateral (
         select s.id from message_images s join messages m on m.id = s.message_id
         where s.id = image.stored_id and m.user_id = $1 and s.data is not null
       ) owned on true
       returning id, mime_type, origin, position, source_image_id, octet_length(data) as byte_size
     ) select message.*, (select jsonb_agg(jsonb_build_object(
         'id', i.id, 'sourceId', coalesce(i.source_image_id, i.id), 'mimeType', i.mime_type,
         'byteSize', coalesce(i.byte_size, octet_length(s.data)), 'origin', i.origin, 'description', s.description
       ) order by i.position) from images i left join message_images s on s.id = i.source_image_id) as images from message`,
    [input.userId, input.role, input.content, input.kind ?? "reply", input.agendaItemId ?? null, input.at, input.replyTo ? JSON.stringify(input.replyTo) : null,
      JSON.stringify(images.map((image, position) => ({
        position, mime_type: image.mimeType, origin: image.origin ?? null, source_key: image.sourceKey ?? null, stored_id: image.storedId ?? null,
        data: image.storedId ? null : Buffer.from(image.data).toString("base64"),
      })))],
  );
  await updateUser(db, input.userId, input.role === "user" ? { lastUserMessageAt: input.at } : { lastEmiMessageAt: input.at });
  return messageFromRow(rows[0]!);
}

export async function messageCount(db: Db, userId: string): Promise<number> {
  const { rows } = await db.query<{ n: string }>("select count(*) as n from messages where user_id = $1", [userId]);
  return Number(rows[0]?.n ?? 0);
}

/** The newest `limit` messages, oldest first. */
export async function recentMessages(db: Db, userId: string, limit: number): Promise<StoredMessage[]> {
  const { rows } = await db.query<Row>(
    `select messages.*, ${IMAGE_REFERENCES_SQL} from messages where user_id = $1 order by id desc limit $2`, [userId, limit],
  );
  return rows.map(messageFromRow).reverse();
}

export async function messagesAfter(db: Db, userId: string, afterId: number, limit = 40): Promise<StoredMessage[]> {
  const { rows } = await db.query<Row>(
    `select messages.*, ${IMAGE_REFERENCES_SQL} from messages where user_id = $1 and id > $2 order by id asc limit $3`, [userId, afterId, limit],
  );
  return rows.map(messageFromRow);
}

// ---- usage ----

export async function recordUsage(db: Db, userId: string, purpose: string, usage: Usage, at: Date): Promise<void> {
  await db.query(
    "insert into usage_events (user_id, purpose, model, input_tokens, output_tokens, cost_usd, created_at) values ($1, $2, $3, $4, $5, $6, $7)",
    [userId, purpose, usage.model, usage.inputTokens, usage.outputTokens, usage.costUsd, at],
  );
}

function startOfLocalDay(now: Date, tz: string): Date {
  return localToUtc(localParts(now, tz).dateKey, tz) ?? new Date(now.getTime() - 24 * 3_600_000);
}

export async function spentToday(db: Db, user: User, now: Date): Promise<number> {
  const { rows } = await db.query<{ total: string | null }>(
    "select sum(cost_usd) as total from usage_events where user_id = $1 and created_at >= $2",
    [user.id, startOfLocalDay(now, user.timezone)],
  );
  return Number(rows[0]?.total ?? 0);
}

/** Whether Emi may still spend on things she does unasked today. */
export async function underDailyCap(db: Db, user: User, now: Date): Promise<boolean> {
  return (await spentToday(db, user, now)) < user.dailyCapUsd;
}

export async function proactiveSentToday(db: Db, user: User, now: Date): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `select count(*) as n from messages m
      left join agenda_items a on a.id = m.agenda_item_id
      where m.user_id = $1 and m.kind = 'proactive' and m.created_at >= $2
        and coalesce(a.kind, 'initiative') <> 'reminder'`,
    [user.id, startOfLocalDay(now, user.timezone)],
  );
  return Number(rows[0]?.n ?? 0);
}
