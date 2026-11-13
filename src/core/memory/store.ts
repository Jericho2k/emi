import { vectorLiteral, type Db } from "../../db";
import type { Memory, MemoryKind } from "../types";

type Row = Record<string, any>;

const toDate = (value: unknown): Date | null => (value == null ? null : value instanceof Date ? value : new Date(String(value)));

export function memoryFromRow(row: Row): Memory {
  return {
    id: row.id, userId: row.user_id, kind: row.kind, content: row.content, status: row.status,
    pinned: row.pinned, source: row.source, evidence: row.evidence,
    occurredOn: row.occurred_on == null ? null : row.occurred_on instanceof Date ? row.occurred_on.toISOString().slice(0, 10) : String(row.occurred_on).slice(0, 10),
    storyline: row.storyline ?? null, lastRelevantAt: toDate(row.last_relevant_at), createdAt: toDate(row.created_at)!,
  };
}

// Never select the embedding column back: it is 1024 floats nobody reads.
const COLUMNS = "id, user_id, kind, content, status, pinned, source, evidence, occurred_on, storyline, last_relevant_at, created_at";

export interface NewMemory {
  userId: string;
  kind: MemoryKind;
  content: string;
  evidence?: string;
  source?: "stated" | "user";
  occurredOn?: string | null;
  storyline?: string | null;
  sourceMessageId?: number | null;
  embedding?: number[] | null;
  pinned?: boolean;
  at: Date;
}

export async function insertMemory(db: Db, input: NewMemory): Promise<Memory> {
  const { rows } = await db.query<Row>(
    `insert into memories (user_id, kind, content, evidence, source, occurred_on, storyline, source_message_id, embedding, pinned, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector, $10, $11, $11) returning ${COLUMNS}`,
    [input.userId, input.kind, input.content, input.evidence ?? "", input.source ?? "stated", input.occurredOn ?? null,
      input.storyline ?? null, input.sourceMessageId ?? null, input.embedding ? vectorLiteral(input.embedding) : null,
      input.pinned ?? false, input.at],
  );
  return memoryFromRow(rows[0]!);
}

export async function activeMemories(db: Db, userId: string): Promise<Memory[]> {
  const { rows } = await db.query<Row>(
    `select ${COLUMNS} from memories where user_id = $1 and status = 'active' order by created_at asc`, [userId],
  );
  return rows.map(memoryFromRow);
}

export async function memoriesByIds(db: Db, userId: string, ids: string[]): Promise<Memory[]> {
  if (!ids.length) return [];
  const { rows } = await db.query<Row>(
    `select ${COLUMNS} from memories where user_id = $1 and id = any($2::uuid[])`, [userId, ids],
  );
  return rows.map(memoryFromRow);
}

/** The old row is kept and linked, so "what did it use to be" stays answerable. */
export async function supersedeMemory(db: Db, userId: string, oldId: string, newId: string, at: Date): Promise<void> {
  await db.query(
    "update memories set status = 'superseded', superseded_by = $3, updated_at = $4 where user_id = $1 and id = $2 and status = 'active'",
    [userId, oldId, newId, at],
  );
}

/** Finds one of the person's memories by the short id shown to them. */
export async function findByShortId(db: Db, userId: string, shortId: string): Promise<Memory | null> {
  const clean = shortId.toLowerCase().replace(/[^0-9a-f]/g, "");
  if (clean.length < 4) return null;
  const { rows } = await db.query<Row>(
    `select ${COLUMNS} from memories where user_id = $1 and status = 'active' and id::text like $2 limit 2`, [userId, `${clean}%`],
  );
  return rows.length === 1 ? memoryFromRow(rows[0]!) : null;
}

export async function deleteMemory(db: Db, userId: string, id: string, at: Date): Promise<void> {
  // The text is blanked as well as hidden: "forget this" has to mean it.
  await db.query(
    "update memories set status = 'deleted', content = '', evidence = '', embedding = null, updated_at = $3 where user_id = $1 and id = $2",
    [userId, id, at],
  );
}

export async function setPinned(db: Db, userId: string, id: string, pinned: boolean, at: Date): Promise<void> {
  await db.query("update memories set pinned = $3, updated_at = $4 where user_id = $1 and id = $2", [userId, id, pinned, at]);
}

export async function markRelevant(db: Db, userId: string, ids: string[], at: Date): Promise<void> {
  if (!ids.length) return;
  await db.query("update memories set last_relevant_at = $3 where user_id = $1 and id = any($2::uuid[])", [userId, ids, at]);
}

export interface Neighbour {
  memory: Memory;
  similarity: number;
}

export async function nearestMemories(db: Db, userId: string, vector: number[], limit: number): Promise<Neighbour[]> {
  const { rows } = await db.query<Row>(
    `select ${COLUMNS}, 1 - (embedding <=> $2::vector) as similarity from memories
      where user_id = $1 and status = 'active' and embedding is not null
      order by embedding <=> $2::vector limit $3`,
    [userId, vectorLiteral(vector), limit],
  );
  return rows.map((row) => ({ memory: memoryFromRow(row), similarity: Number(row.similarity) }));
}

/** Words worth matching on: letters and digits only, so the query is always safe. */
export function searchTerms(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.toLowerCase().matchAll(/[\p{L}\p{N}]{3,}/gu)) {
    seen.add(match[0]);
    if (seen.size >= 12) break;
  }
  return [...seen];
}

export async function lexicalMemories(db: Db, userId: string, text: string, limit: number): Promise<Array<{ memory: Memory; rank: number }>> {
  const terms = searchTerms(text);
  if (!terms.length) return [];
  const { rows } = await db.query<Row>(
    `select ${COLUMNS}, ts_rank(tsv, q) as rank from memories, to_tsquery('simple', $2) q
      where user_id = $1 and status = 'active' and tsv @@ q order by rank desc limit $3`,
    [userId, terms.join(" | "), limit],
  );
  return rows.map((row) => ({ memory: memoryFromRow(row), rank: Number(row.rank) }));
}
