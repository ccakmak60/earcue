// YYYY-MM-DD in the runtime's local time zone. Right in the browser, where the runtime's zone is
// the user's; server-side use localDayIn, because a Worker's zone is UTC and not the user's.
export function localDayOf(date: Date): string {
  return date.toLocaleDateString("en-CA");
}

// YYYY-MM-DD for a moment as seen in `tz` (IANA name). An unknown or empty zone falls back to UTC.
export function localDayIn(date: Date, tz: string | null | undefined): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz || "UTC" }).format(date);
}

// The `count` local days ending at `today`, oldest first, as YYYY-MM-DD.
export function recentDays(today: Date, count: number): string[] {
  const days: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    days.push(localDayOf(d));
  }
  return days;
}

// Activity bucket for a day's trace count: 0 (none) through 4 (busiest).
export function activityLevel(count: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0) return 0;
  if (count < 20) return 1;
  if (count < 60) return 2;
  if (count < 150) return 3;
  return 4;
}
