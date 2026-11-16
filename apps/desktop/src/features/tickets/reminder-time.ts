/**
 * Whether the field holds a whole date and time yet. While a year is still being
 * typed the field reports years such as 0006; that is unfinished, not invalid.
 */
export function complete(value: string): boolean {
  const match = /^(\d{4})-\d{2}-\d{2}T\d{2}:\d{2}$/.exec(value);
  return match !== null && Number(match[1]) >= 1000;
}

// A local clock time may be skipped or occur twice during a time-zone transition.
export function localInstants(value: string): Date[] {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return [];
  const [, y, m, d, h, min] = match;
  const utc = Date.UTC(
    Number(y),
    Number(m) - 1,
    Number(d),
    Number(h),
    Number(min),
  );
  const offsets = new Set<number>();
  for (let delta = -48; delta <= 48; delta++)
    offsets.add(new Date(utc + delta * 3600000).getTimezoneOffset());
  return [...offsets]
    .map((offset) => new Date(utc + offset * 60000))
    .filter(
      (date) =>
        date.getFullYear() === Number(y) &&
        date.getMonth() === Number(m) - 1 &&
        date.getDate() === Number(d) &&
        date.getHours() === Number(h) &&
        date.getMinutes() === Number(min),
    )
    .sort((a, b) => a.getTime() - b.getTime());
}
export function offsetLabel(date: Date): string {
  const minutes = -date.getTimezoneOffset();
  const sign = minutes >= 0 ? "+" : "−";
  return `UTC${sign}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, "0")}:${String(Math.abs(minutes) % 60).padStart(2, "0")}`;
}

/** "Bangkok (UTC+07:00)": the zone the reminder's time is read in. */
export function zoneLabel(now: Date): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const place = zone?.split("/").pop()?.replaceAll("_", " ");
  return place
    ? `${place} (${offsetLabel(now)})`
    : `Your local time (${offsetLabel(now)})`;
}

/** The value a datetime-local field shows for an instant, in local time. */
export function localValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
