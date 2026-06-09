/** ISO-week id (e.g. "2026-W24") for an instant, with a configurable hour offset. */
export function weekIdFor(now: Date, resetOffsetHours: number): string {
  const shifted = new Date(now.getTime() - resetOffsetHours * 3600_000);
  const { year, week } = isoWeek(shifted);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** Start (inclusive) and end (exclusive) instants for a weekId. */
export function weekWindow(weekId: string, resetOffsetHours: number): { startsAt: Date; endsAt: Date } {
  const [yearStr, weekStr] = weekId.split('-W');
  const year = Number(yearStr);
  const week = Number(weekStr);
  const monday = isoWeekMonday(year, week);
  const startsAt = new Date(monday.getTime() + resetOffsetHours * 3600_000);
  const endsAt = new Date(startsAt.getTime() + 7 * 24 * 3600_000);
  return { startsAt, endsAt };
}

/** ISO-8601 week number and ISO week-year for a UTC instant. */
function isoWeek(d: Date): { year: number; week: number } {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // ISO weekday: Mon=1..Sun=7. Shift to the Thursday of this week.
  const dayNum = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const year = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { year, week };
}

/** The UTC Monday 00:00 that starts the given ISO week. */
function isoWeekMonday(isoYear: number, isoWeek: number): Date {
  // Jan 4th is always in ISO week 1.
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Day = jan4.getUTCDay() === 0 ? 7 : jan4.getUTCDay();
  const week1Monday = new Date(jan4.getTime() - (jan4Day - 1) * 86400000);
  return new Date(week1Monday.getTime() + (isoWeek - 1) * 7 * 86400000);
}
