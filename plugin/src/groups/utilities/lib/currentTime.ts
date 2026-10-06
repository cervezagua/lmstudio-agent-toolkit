import { ToolError } from "../../../shared/errors";

/**
 * The current date and time in a time zone, written out the same way on every machine: Intl is only
 * asked for numbers, and the weekday and month names come from the lists below, so the machine's
 * locale never shows through.
 */

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAY_MS = 86_400_000;

export interface ZonedTime {
  /** The zone's name: the one asked for, or the system's. */
  timeZone: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday. */
  weekday: number;
  /** Minutes east of UTC. */
  offsetMinutes: number;
  isoWeek: number;
  /** The year the ISO week belongs to, which differs from the calendar year around 1 January. */
  isoWeekYear: number;
  dayOfYear: number;
}

export function systemTimeZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
  } catch {
    throw new ToolError(`"${timeZone}" is not a time zone. Use an IANA name such as Europe/Lisbon, America/New_York or Asia/Kolkata.`);
  }
}

/** ISO 8601 weeks start on Monday, and week 1 is the one with the year's first Thursday in it. */
function isoWeekOf(year: number, month: number, day: number): { week: number; weekYear: number } {
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay() || 7;
  // The Thursday of this week decides which year the week belongs to.
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const weekYear = date.getUTCFullYear();
  const week = Math.ceil(((date.getTime() - Date.UTC(weekYear, 0, 1)) / DAY_MS + 1) / 7);
  return { week, weekYear };
}

export function zonedTime(now: Date, timezone?: string): ZonedTime {
  // The name is shown as it was asked for: Intl reports some zones under an older alias (Asia/Calcutta).
  const timeZone = timezone?.trim() || systemTimeZone();
  const formatter = formatterFor(timeZone);
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(now)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  const { year, month, day, minute, second } = parts;
  const hour = parts.hour % 24;
  // The wall-clock time read as if it were UTC, minus the real instant, is the zone's offset.
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const offsetMinutes = Math.round((asUtc - Math.floor(now.getTime() / 1000) * 1000) / 60_000);
  const { week, weekYear } = isoWeekOf(year, month, day);
  return {
    timeZone,
    year,
    month,
    day,
    hour,
    minute,
    second,
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
    offsetMinutes,
    isoWeek: week,
    isoWeekYear: weekYear,
    dayOfYear: Math.round((Date.UTC(year, month - 1, day) - Date.UTC(year, 0, 1)) / DAY_MS) + 1,
  };
}

const two = (value: number) => String(value).padStart(2, "0");

function formatOffset(minutes: number): string {
  const size = Math.abs(minutes);
  return `${minutes < 0 ? "-" : "+"}${two(Math.floor(size / 60))}:${two(size % 60)}`;
}

/** What the current_time tool answers. Throws ToolError for a zone that does not exist. */
export function formatCurrentTime(now: Date, timezone?: string): string {
  const t = zonedTime(now, timezone);
  const time = `${two(t.hour)}:${two(t.minute)}:${two(t.second)}`;
  const offset = formatOffset(t.offsetMinutes);
  const date = `${String(t.year).padStart(4, "0")}-${two(t.month)}-${two(t.day)}`;
  return [
    `${WEEKDAYS[t.weekday]}, ${t.day} ${MONTHS[t.month - 1]} ${t.year}, ${time}`,
    `Time zone: ${t.timeZone} (UTC${offset})`,
    `ISO 8601: ${date}T${time}${offset}`,
    `ISO week ${t.isoWeek} of ${t.isoWeekYear}, day ${t.dayOfYear} of the year`,
  ].join("\n");
}
