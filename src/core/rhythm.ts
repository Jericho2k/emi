import type { TurnKind } from "./prompt";

/**
 * HOW FAST SHE TEXTS.
 *
 * A person reads, then types, and a second message takes as long to type as
 * its length. Three bubbles 350ms apart read as a machine. Only chatting is
 * paced: a task answer goes out as soon as it is written, because waiting
 * for help is never part of the charm.
 *
 * The model's own writing time counts towards the pause, so pacing only adds
 * a wait when the model was faster than a person would have been.
 */

/** Characters per second she "types" at. Quicker than a thumb, so it never drags. */
export const TYPING_CPS = 22;
export const TYPING_MIN_MS = 700;
export const TYPING_MAX_MS = 4500;

export function isPaced(turnKind: TurnKind): boolean {
  return turnKind === "social";
}

/** A moment to read their message before she starts typing. */
export function readDelayMs(random: () => number): number {
  return Math.round(600 + random() * 1400);
}

/** How long one bubble takes to type, with a little human unevenness. */
export function typingMs(text: string, random: () => number): number {
  const base = (text.length / TYPING_CPS) * 1000;
  const jittered = base * (0.8 + random() * 0.4);
  return Math.round(Math.min(TYPING_MAX_MS, Math.max(TYPING_MIN_MS, jittered)));
}

/**
 * How long to wait before each bubble goes out. The first wait is shortened
 * by however long the reply already took to write.
 */
export function bubbleWaits(bubbles: string[], elapsedMs: number, random: () => number): number[] {
  return bubbles.map((bubble, index) => {
    const typing = typingMs(bubble, random);
    return index === 0 ? Math.max(0, readDelayMs(random) + typing - elapsedMs) : typing;
  });
}
