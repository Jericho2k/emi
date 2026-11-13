import type { Memory, MemoryKind } from "../types";
import type { Neighbour } from "./store";

export interface Candidate {
  kind: MemoryKind;
  content: string;
  evidence: string;
  occurredOn: string | null;
  storyline: string | null;
  /** A stored memory the extractor believes this one replaces. */
  supersedes: Memory | null;
}

export type Decision =
  | { action: "add" }
  | { action: "skip"; duplicateOf: string }
  | { action: "supersede"; targetId: string };

/** Close enough to be the same statement said again. */
export const DUPLICATE_SIMILARITY = 0.9;

const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * What to do with one newly extracted memory. Deterministic: the model may
 * propose a replacement, but these rules decide whether it is allowed.
 *
 *   - An event is something that happened. It is never retired as outdated, and
 *     two events on different days are never the same event, however alike.
 *   - Everything else is a state and may be replaced by a newer one.
 *   - What the person wrote or pinned themselves is never replaced by a model.
 *
 * Every doubtful case ends in "add": tidiness must never cost a memory.
 */
export function decide(candidate: Candidate, neighbours: Neighbour[]): Decision {
  const text = normalize(candidate.content);
  for (const { memory, similarity } of neighbours) {
    if (memory.kind !== candidate.kind) continue;
    const same = similarity >= DUPLICATE_SIMILARITY || normalize(memory.content) === text;
    if (!same) continue;
    if (candidate.kind === "event" && (memory.occurredOn ?? null) !== (candidate.occurredOn ?? null)) continue;
    return { action: "skip", duplicateOf: memory.id };
  }

  const target = candidate.supersedes;
  if (target && candidate.kind !== "event" && target.kind !== "event"
    && target.status === "active" && !target.pinned && target.source !== "user") {
    return { action: "supersede", targetId: target.id };
  }
  return { action: "add" };
}

/** Things that must never be written to memory, whatever the model proposed. */
export function looksSensitive(text: string): boolean {
  if (/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/.test(text)) return true;
  if (/\b(?:\d[ -]?){13,19}\b/.test(text)) return true;
  if (/\b(password|passcode|пароль|cvv|cvc|seed phrase|private key)\b/i.test(text)) return true;
  return false;
}

/** The quote must really be something the person wrote. */
export function evidenceIsExact(evidence: string, source: string): boolean {
  const quote = normalize(evidence);
  return quote.length >= 3 && normalize(source).includes(quote);
}
