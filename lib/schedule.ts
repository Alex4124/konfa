import { Temporal } from "@js-temporal/polyfill";
import { AppError } from "./app-error.ts";
import type { RoomKind } from "./confa-types.ts";

export type Recurrence = "once" | "daily" | "weekly" | "weekdays";
export type ScheduleInput = {
  title: string; kind: RoomKind; startDate: string; startTime: string;
  durationMinutes: number; timezone: string; recurrence: Recurrence; weekdays: number;
};
export type ScheduleRow = {
  id: string; owner_id: string; title: string; kind: RoomKind; start_date: string; start_time: string;
  duration_minutes: number; timezone: string; recurrence: Recurrence; weekdays: number;
  status: "active" | "cancelled"; active_room_id: string | null; created_at: number; updated_at: number;
};

export function parseSchedule(input: Record<string, unknown>, timezoneOverride?: string): ScheduleInput {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title || title.length > 100) throw new AppError("Название должно содержать от 1 до 100 символов");
  if (input.kind !== "meeting" && input.kind !== "webinar") throw new AppError("Выберите встречу или вебинар");
  const startDate = input.startDate;
  const startTime = input.startTime;
  if (typeof startDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw new AppError("Укажите дату начала");
  if (typeof startTime !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime)) throw new AppError("Укажите время начала");
  try { if (Temporal.PlainDate.from(startDate).toString() !== startDate) throw new Error(); }
  catch { throw new AppError("Некорректная дата начала"); }
  const durationMinutes = input.durationMinutes;
  if (!Number.isInteger(durationMinutes) || (durationMinutes as number) < 15 || (durationMinutes as number) > 480) throw new AppError("Длительность должна быть от 15 до 480 минут");
  const timezone = timezoneOverride ?? input.timezone;
  if (typeof timezone !== "string" || timezone.length > 80) throw new AppError("Укажите часовой пояс");
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(); }
  catch { throw new AppError("Неизвестный часовой пояс"); }
  if (input.recurrence !== "once" && input.recurrence !== "daily" && input.recurrence !== "weekly" && input.recurrence !== "weekdays") throw new AppError("Выберите повторение");
  const recurrence = input.recurrence;
  const weekdays = recurrence === "weekdays" ? input.weekdays : 0;
  if (recurrence === "weekdays" && (!Number.isInteger(weekdays) || (weekdays as number) < 1 || (weekdays as number) > 127)) throw new AppError("Выберите хотя бы один день недели");
  return { title, kind: input.kind, startDate, startTime, durationMinutes: durationMinutes as number, timezone, recurrence, weekdays: weekdays as number };
}

export function occurrenceAt(schedule: Pick<ScheduleRow, "start_date" | "start_time" | "timezone" | "recurrence" | "weekdays">, date: Temporal.PlainDate): number | null {
  const first = Temporal.PlainDate.from(schedule.start_date);
  if (Temporal.PlainDate.compare(date, first) < 0) return null;
  if (schedule.recurrence === "once" && !date.equals(first)) return null;
  if (schedule.recurrence === "weekly" && date.dayOfWeek !== first.dayOfWeek) return null;
  if (schedule.recurrence === "weekdays" && !(schedule.weekdays & (1 << (date.dayOfWeek - 1)))) return null;
  const [hour, minute] = schedule.start_time.split(":").map(Number);
  const zoned = Temporal.ZonedDateTime.from({ timeZone: schedule.timezone, year: date.year, month: date.month, day: date.day, hour, minute }, { disambiguation: "compatible" });
  return zoned.epochMilliseconds;
}

export function nextOccurrence(schedule: Pick<ScheduleRow, "start_date" | "start_time" | "timezone" | "recurrence" | "weekdays" | "duration_minutes">, now = Date.now()): number | null {
  const today = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(schedule.timezone).toPlainDate();
  let date = Temporal.PlainDate.from(schedule.start_date);
  if (Temporal.PlainDate.compare(date, today) < 0) date = today;
  for (let day = 0; day < 370; day++, date = date.add({ days: 1 })) {
    const start = occurrenceAt(schedule, date);
    if (start !== null && start + schedule.duration_minutes * 60_000 > now) return start;
    if (schedule.recurrence === "once") return null;
  }
  return null;
}

export function currentOccurrence(schedule: Pick<ScheduleRow, "start_date" | "start_time" | "timezone" | "recurrence" | "weekdays" | "duration_minutes">, now = Date.now()): number | null {
  const date = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(schedule.timezone).toPlainDate();
  const start = occurrenceAt(schedule, date);
  return start !== null && start <= now && now < start + schedule.duration_minutes * 60_000 ? start : null;
}

export function missedOccurrences(schedule: Pick<ScheduleRow, "start_date" | "start_time" | "timezone" | "recurrence" | "weekdays" | "duration_minutes">, fulfilled: Set<number>, now = Date.now()): number[] {
  const today = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(schedule.timezone).toPlainDate();
  const first = Temporal.PlainDate.from(schedule.start_date);
  let date = today.subtract({ days: 30 });
  if (Temporal.PlainDate.compare(date, first) < 0) date = first;
  const missed: number[] = [];
  while (Temporal.PlainDate.compare(date, today) <= 0) {
    const start = occurrenceAt(schedule, date);
    if (start !== null && start + schedule.duration_minutes * 60_000 <= now && !fulfilled.has(start)) missed.push(start);
    date = date.add({ days: 1 });
  }
  return missed;
}
