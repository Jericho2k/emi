import type { Db } from "../../db";
import type { Memory, MemoryKind } from "../types";
import { relevantArcs, type Arc } from "./timeline";
import { activeMemories, lexicalMemories, markRelevant, nearestMemories } from "./store";

/**
 * How long a memory of each kind stays fresh, in real days.
 *
 * Afterglow ages memories by story distance because a roleplay can sit idle
 * for months while minutes pass in the fiction. Here the calendar IS the story,
 * so wall-clock age is the signal: a name outlasts last week's errand.
 */
export const HALF_LIFE_DAYS: Record<MemoryKind, number> = {
  identity: 3650, boundary: 3650, relationship: 365, preference: 365, state: 90, event: 45,
};

/** Below this, nothing is on topic and nothing is recalled. */
export const RELEVANCE_FLOOR = 0.3;
/** A memory must reach this share of the turn's best match. */
export const ADMISSION_SHARE = 0.5;
/** Safety ceiling, not a budget: small talk recalls few, a long thread many. */
export const RELEVANT_LIMIT = 12;
export const STANDING_LIMIT = 8;
const STORYLINE_EXTRA = 3;

export function recency(memory: Pick<Memory, "kind" | "createdAt" | "occurredOn">, now: Date): number {
  const anchor = memory.occurredOn ? new Date(`${memory.occurredOn}T12:00:00Z`) : memory.createdAt;
  const ageDays = Math.max(0, (now.getTime() - anchor.getTime()) / 86_400_000);
  return 1 / (1 + ageDays / HALF_LIFE_DAYS[memory.kind]);
}

export interface Scored {
  memory: Memory;
  score: number;
}

/**
 * Relevance decides; recency only separates near-ties. Kept pure so the
 * admission rule can be tested without a database.
 */
export function admit(candidates: Array<{ memory: Memory; similarity: number; lexical: number }>, now: Date): Scored[] {
  const scored = candidates.map(({ memory, similarity, lexical }) => ({
    memory,
    score: (similarity > 0 ? similarity + 0.15 * lexical : 0.5 * lexical) + 0.05 * recency(memory, now),
  })).sort((a, b) => b.score - a.score);
  const best = scored[0]?.score ?? 0;
  if (best < RELEVANCE_FLOOR) return [];
  const bar = Math.max(RELEVANCE_FLOOR, best * ADMISSION_SHARE);
  return scored.filter((item) => item.score >= bar).slice(0, RELEVANT_LIMIT);
}

const when = (memory: Memory) => (memory.occurredOn ? new Date(`${memory.occurredOn}T12:00:00Z`).getTime() : memory.createdAt.getTime());

export interface Recall {
  /** Carried on every turn: who they are, what they asked her never to do, what they pinned. */
  standing: Memory[];
  /** Admitted for this turn on relevance, in the order things happened. */
  relevant: Memory[];
  /** Chapters of older conversation that this turn is about. */
  arcs: Arc[];
}

export async function recall(db: Db, userId: string, queryText: string, queryVector: number[] | null, now: Date): Promise<Recall> {
  const all = await activeMemories(db, userId);
  const arcs = queryVector ? await relevantArcs(db, userId, queryVector) : [];
  if (!all.length) return { standing: [], relevant: [], arcs };

  const standing = [
    ...all.filter((memory) => memory.pinned),
    ...all.filter((memory) => !memory.pinned && (memory.kind === "identity" || memory.kind === "boundary")).reverse(),
  ].slice(0, STANDING_LIMIT);
  const standingIds = new Set(standing.map((memory) => memory.id));

  const merged = new Map<string, { memory: Memory; similarity: number; lexical: number }>();
  if (queryVector) {
    for (const hit of await nearestMemories(db, userId, queryVector, 40)) {
      merged.set(hit.memory.id, { memory: hit.memory, similarity: Math.max(0, hit.similarity), lexical: 0 });
    }
  }
  const lexical = await lexicalMemories(db, userId, queryText, 20);
  const topRank = Math.max(...lexical.map((hit) => hit.rank), 0);
  for (const hit of lexical) {
    const entry = merged.get(hit.memory.id) ?? { memory: hit.memory, similarity: 0, lexical: 0 };
    entry.lexical = topRank > 0 ? hit.rank / topRank : 0;
    merged.set(hit.memory.id, entry);
  }

  const admitted = admit([...merged.values()].filter((entry) => !standingIds.has(entry.memory.id)), now).map((item) => item.memory);
  // A memory that earned its place refreshes; a standing one does not, or it
  // would keep proving its own relevance forever.
  await markRelevant(db, userId, admitted.map((memory) => memory.id), now);

  // When one beat of a thread matches, bring a little of the rest of it.
  const taken = new Set([...standingIds, ...admitted.map((memory) => memory.id)]);
  const storylines = new Set(admitted.map((memory) => memory.storyline).filter((name): name is string => !!name));
  const extra = all.filter((memory) => memory.storyline && storylines.has(memory.storyline) && !taken.has(memory.id)).slice(-STORYLINE_EXTRA);

  return { standing, relevant: [...admitted, ...extra].sort((a, b) => when(a) - when(b)), arcs };
}
