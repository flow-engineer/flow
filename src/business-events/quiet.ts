// Quiet hours for business events, in one zone the business names (its customers' zone): a
// standard or optional message that comes inside them is held and sent when they end.

export interface EventQuietHours {
  /** "22:00": they start. */
  from: string;
  /** "08:00": they end (the next day when it is before `from`). */
  to: string;
}

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
};

/** Minutes since local midnight in `zone`, and that local midnight as an instant. */
function local(zone: string, now: number) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const mins = Number(parts.hour) * 60 + Number(parts.minute);
  const startOfMinute = now - Number(parts.second) * 1000 - (now % 1000);
  return { mins, midnight: startOfMinute - mins * 60_000 };
}

/** When quiet hours end, if `now` is inside them in `zone`; else null. */
export function quietHoursEnd(hours: EventQuietHours, zone: string, now: number): number | null {
  const f = minutes(hours.from);
  const t = minutes(hours.to);
  const { mins, midnight } = local(zone, now);
  const inside = f > t ? mins >= f || mins < t : mins >= f && mins < t;
  if (!inside) return null;
  return midnight + t * 60_000 + (mins >= t ? 24 * 60 * 60_000 : 0);
}
