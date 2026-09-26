export type LocalTimeResult = { readonly ok: true; readonly utcText: string } | { readonly ok: false; readonly reason: string };

const pattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

export function localDateTimeToUtcText(localText: string): LocalTimeResult {
  const parts = pattern.exec(localText);
  if (!parts) return { ok: false, reason: "Choose a complete local date and time or enter UTC directly." };
  const [year, month, day, hour, minute] = parts.slice(1).map(Number);
  const local = new Date(year!, month! - 1, day, hour, minute);
  if (formatLocal(local) !== localText) return { ok: false, reason: "This local date and time does not exist; enter UTC directly." };
  const nominalUtc = Date.UTC(year!, month! - 1, day, hour, minute);
  const offsets = new Set([local.getTimezoneOffset(), new Date(local.getTime() - 86_400_000).getTimezoneOffset(), new Date(local.getTime() + 86_400_000).getTimezoneOffset()]);
  const matches = [...offsets].map((offset) => new Date(nominalUtc + offset * 60_000)).filter((instant) => formatLocal(instant) === localText);
  if (matches.length !== 1) return { ok: false, reason: "This local time occurs twice; enter the intended UTC time directly." };
  return { ok: true, utcText: matches[0]!.toISOString().slice(0, 16) };
}

export function utcTextToLocalDateTime(utcText: string): string | undefined {
  if (!pattern.test(utcText)) return undefined;
  const instant = new Date(`${utcText}:00Z`);
  if (!Number.isFinite(instant.getTime()) || instant.toISOString().slice(0, 16) !== utcText) return undefined;
  return formatLocal(instant);
}

function formatLocal(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
