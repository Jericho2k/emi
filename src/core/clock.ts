/**
 * Real time, in the person's own timezone.
 *
 * Everything Emi says about "today", "tonight" or "three days ago" comes from
 * here. Message count is never time.
 */

export type Clock = () => Date;

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** Mon, Tue, ... */
  weekday: string;
  /** YYYY-MM-DD in the person's timezone. */
  dateKey: string;
}

export function isValidTimeZone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function localParts(date: Date, tz: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: isValidTimeZone(tz) ? tz : "UTC",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const year = Number(get("year")), month = Number(get("month")), day = Number(get("day"));
  return {
    year, month, day,
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    weekday: get("weekday"),
    dateKey: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  };
}

/**
 * Turns a wall-clock time in a timezone into the instant it names.
 * Accepts "YYYY-MM-DD" (midnight) or "YYYY-MM-DDTHH:mm".
 */
export function localToUtc(local: string, tz: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(local.trim());
  if (!match) return null;
  const [year, month, day, hour, minute] = [1, 2, 3, 4, 5].map((index) => Number(match[index] ?? 0)) as [number, number, number, number, number];
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  // The offset depends on the instant, so correct twice to land right across
  // a daylight-saving change.
  let guess = wanted;
  for (let pass = 0; pass < 2; pass += 1) {
    const seen = localParts(new Date(guess), tz);
    const seenAsUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute);
    guess += wanted - seenAsUtc;
  }
  return new Date(guess);
}

export function hasTimeOfDay(local: string): boolean {
  return /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(local.trim());
}

export function inQuietHours(date: Date, tz: string, start: number, end: number): boolean {
  if (start === end) return false;
  const { hour } = localParts(date, tz);
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** The first moment at or after `date` that is outside quiet hours. */
export function nextAwake(date: Date, tz: string, start: number, end: number): Date {
  if (!inQuietHours(date, tz, start, end)) return date;
  const local = localParts(date, tz);
  const today = localToUtc(`${local.dateKey}T${String(end).padStart(2, "0")}:00`, tz);
  if (today && today.getTime() >= date.getTime()) return today;
  const tomorrow = localParts(new Date(date.getTime() + 24 * 3_600_000), tz);
  return localToUtc(`${tomorrow.dateKey}T${String(end).padStart(2, "0")}:00`, tz) ?? date;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function describeMoment(date: Date, tz: string): string {
  const local = localParts(date, tz);
  return `${local.weekday} ${local.day} ${MONTHS[local.month - 1]} ${local.year}, ${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}`;
}

export function describeDay(date: Date, tz: string): string {
  const local = localParts(date, tz);
  return `${local.weekday} ${local.day} ${MONTHS[local.month - 1]}`;
}

export function describeGap(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 2) return "moments";
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

/** Whole calendar days between two instants, in the person's timezone. */
export function localDaysBetween(earlier: Date, later: Date, tz: string): number {
  const a = localParts(earlier, tz), b = localParts(later, tz);
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000);
}
