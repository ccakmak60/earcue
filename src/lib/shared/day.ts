// YYYY-MM-DD in the runtime's local time zone.
export function localDayOf(date: Date): string {
  return date.toLocaleDateString("en-CA");
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
