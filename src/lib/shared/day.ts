// YYYY-MM-DD in the runtime's local time zone.
export function localDayOf(date: Date): string {
  return date.toLocaleDateString("en-CA");
}
