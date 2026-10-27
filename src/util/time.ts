// Calendar days in a named time zone ("Europe/Istanbul"), with nothing but Intl. Reports count days in the
// project's zone so late-night work lands on the day people remember doing it.

export const DAY_MS = 86_400_000;

export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function parts(t: number, tz: string): Record<string, number> {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(tz, f);
  }
  const out: Record<string, number> = {};
  for (const p of f.formatToParts(t)) if (p.type !== "literal") out[p.type] = Number(p.value);
  return out;
}

// "2026-09-22": the calendar day an instant falls on in `tz`.
export function dayKey(t: number, tz: string): string {
  const p = parts(t, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

// How far `tz` is ahead of UTC at instant t, in ms (Istanbul: +3 h).
function offset(t: number, tz: string): number {
  const p = parts(t, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
}

// The instant a calendar day starts in `tz`. Checked twice so a DST change on that day is handled.
export function startOfDay(day: string, tz: string): number {
  const guess = Date.parse(`${day}T00:00:00Z`);
  const first = guess - offset(guess, tz);
  return guess - offset(first, tz);
}

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}
