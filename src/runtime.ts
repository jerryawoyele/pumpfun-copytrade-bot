import { config } from "./config.js";

function parseTime(time: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) {
    throw new Error(`Invalid time format "${time}". Use HH:MM.`);
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours * 60 + minutes;
}

function getMinutesInTimezone(date: Date, timezone: string): number {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

export function isWithinRunWindow(date = new Date()): boolean {
  const start = parseTime(config.runtime.runWindowStart);
  const end = parseTime(config.runtime.runWindowEnd);
  const now = getMinutesInTimezone(date, config.runtime.timezone);

  if (start === end) {
    return true;
  }

  if (start < end) {
    return now >= start && now < end;
  }

  return now >= start || now < end;
}
