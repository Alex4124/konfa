import assert from "node:assert/strict";
import test from "node:test";
import { Temporal } from "@js-temporal/polyfill";
import { currentOccurrence, missedOccurrences, nextOccurrence, occurrenceAt, parseSchedule, type ScheduleRow } from "./schedule.ts";

function schedule(overrides: Partial<ScheduleRow> = {}): ScheduleRow {
  return {
    id: "s", owner_id: "a", title: "Урок", kind: "meeting", start_date: "2026-10-12", start_time: "18:00",
    duration_minutes: 60, timezone: "Europe/Moscow", recurrence: "daily", weekdays: 0,
    status: "active", active_room_id: null, created_at: 0, updated_at: 0, ...overrides,
  };
}

test("daily series skips an elapsed window and marks unstarted dates missed", () => {
  const item = schedule();
  const first = Date.parse("2026-10-12T15:00:00Z");
  assert.equal(nextOccurrence(item, first + 30 * 60_000), first);
  assert.equal(nextOccurrence(item, first + 60 * 60_000), first + 86400_000);
  assert.equal(currentOccurrence(item, first + 30 * 60_000), first);
  assert.equal(currentOccurrence(item, first + 60 * 60_000), null);
  assert.deepEqual(missedOccurrences(item, new Set(), first + 60 * 60_000), [first]);
  assert.deepEqual(missedOccurrences(item, new Set([first]), first + 60 * 60_000), []);
});

test("weekly and chosen weekdays follow local calendar dates", () => {
  const monday = Date.parse("2026-10-12T15:00:00Z");
  assert.equal(nextOccurrence(schedule({ recurrence: "weekly" }), monday + 60 * 60_000), monday + 7 * 86400_000);
  const mondayWednesday = schedule({ recurrence: "weekdays", weekdays: 1 | 4 });
  assert.equal(nextOccurrence(mondayWednesday, monday + 60 * 60_000), monday + 2 * 86400_000);
  assert.equal(occurrenceAt(mondayWednesday, Temporal.PlainDate.from("2026-10-13")), null);
});

test("DST gap moves forward and overlap uses the first local time", () => {
  const spring = schedule({ start_date: "2027-03-14", start_time: "02:30", timezone: "America/New_York", recurrence: "once" });
  assert.equal(occurrenceAt(spring, Temporal.PlainDate.from("2027-03-14")), Date.parse("2027-03-14T07:30:00Z"));
  const autumn = schedule({ start_date: "2027-11-07", start_time: "01:30", timezone: "America/New_York", recurrence: "once" });
  assert.equal(occurrenceAt(autumn, Temporal.PlainDate.from("2027-11-07")), Date.parse("2027-11-07T05:30:00Z"));
});

test("invalid recurrence and weekday selection are rejected", () => {
  const input = { title: "Урок", kind: "meeting", startDate: "2026-10-12", startTime: "18:00", durationMinutes: 60, timezone: "Europe/Moscow", recurrence: "weekdays", weekdays: 0 };
  assert.throws(() => parseSchedule(input));
  assert.equal(parseSchedule({ ...input, weekdays: 5 }).weekdays, 5);
});
