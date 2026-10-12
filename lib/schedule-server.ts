import { getAccount, requireSameOrigin, type Account } from "@/lib/account-server";
import { AppError, db, livekitRequest, mediaConfig, randomSecret, sha256 } from "@/lib/confa-server";
import { currentOccurrence, missedOccurrences, nextOccurrence, parseSchedule, type ScheduleRow } from "@/lib/schedule";

async function scheduleById(id: string): Promise<ScheduleRow> {
  const row = await db().prepare("SELECT * FROM schedules WHERE id = ?").bind(id).first<ScheduleRow>();
  if (!row) throw new AppError("Конференция не найдена", 404);
  return row;
}

async function ownedSchedule(request: Request, id: string): Promise<{ account: Account; schedule: ScheduleRow }> {
  const account = await getAccount(request, true) as Account;
  const schedule = await scheduleById(id);
  if (schedule.owner_id !== account.id) throw new AppError("Нет доступа к расписанию", 403);
  return { account, schedule };
}

async function scheduleView(request: Request, schedule: ScheduleRow, account: Account | null) {
  const database = db();
  const [room, sessions] = await Promise.all([
    schedule.active_room_id ? database.prepare("SELECT status FROM rooms WHERE id = ?").bind(schedule.active_room_id).first<{ status: string }>() : Promise.resolve(null),
    database.prepare("SELECT planned_start_at, started_at, ended_at FROM schedule_sessions WHERE schedule_id = ? ORDER BY started_at DESC LIMIT 100").bind(schedule.id).all<{ planned_start_at: number | null; started_at: number; ended_at: number | null }>(),
  ]);
  const completed = schedule.recurrence === "once" && sessions.results.length > 0;
  const fulfilled = new Set(sessions.results.map((session) => session.planned_start_at).filter((value): value is number => value !== null));
  const missedAt = account?.id === schedule.owner_id && schedule.status === "active" && !completed ? missedOccurrences(schedule, fulfilled) : [];
  return {
    id: schedule.id, title: schedule.title, kind: schedule.kind,
    startDate: schedule.start_date, startTime: schedule.start_time, durationMinutes: schedule.duration_minutes,
    timezone: schedule.timezone, recurrence: schedule.recurrence, weekdays: schedule.weekdays,
    status: schedule.status, completed,
    nextStartAt: schedule.status === "active" && !completed ? nextOccurrence(schedule) : null,
    activeRoomId: room?.status === "open" ? schedule.active_room_id : null,
    isOwner: account?.id === schedule.owner_id,
    guestUrl: `${new URL(request.url).origin}/s/${schedule.id}`,
    lastStartedAt: sessions.results[0]?.started_at ?? null,
    missedAt,
  };
}

export async function getPublicSchedule(request: Request, id: string): Promise<unknown> {
  return scheduleView(request, await scheduleById(id), await getAccount(request));
}

export async function listSchedules(request: Request): Promise<unknown> {
  const account = await getAccount(request, true) as Account;
  const rows = await db().prepare("SELECT * FROM schedules WHERE owner_id = ? ORDER BY created_at DESC LIMIT 100").bind(account.id).all<ScheduleRow>();
  return Promise.all(rows.results.map((row) => scheduleView(request, row, account)));
}

export async function createSchedule(request: Request, input: Record<string, unknown>): Promise<unknown> {
  requireSameOrigin(request);
  const account = await getAccount(request, true) as Account;
  const data = parseSchedule(input);
  const scheduled = nextOccurrence({ start_date: data.startDate, start_time: data.startTime, timezone: data.timezone, recurrence: data.recurrence, weekdays: data.weekdays, duration_minutes: data.durationMinutes });
  if (scheduled === null) throw new AppError("Выберите будущую дату и время");
  const database = db();
  const count = await database.prepare("SELECT COUNT(*) AS count FROM schedules WHERE owner_id = ? AND status = 'active'").bind(account.id).first<{ count: number }>();
  if ((count?.count || 0) >= 100) throw new AppError("Достигнут предел: 100 активных конференций", 429);
  const id = crypto.randomUUID();
  const now = Date.now();
  await database.prepare("INSERT INTO schedules (id, owner_id, title, kind, start_date, start_time, duration_minutes, timezone, recurrence, weekdays, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)")
    .bind(id, account.id, data.title, data.kind, data.startDate, data.startTime, data.durationMinutes, data.timezone, data.recurrence, data.weekdays, now, now).run();
  return scheduleView(request, await scheduleById(id), account);
}

export async function editSchedule(request: Request, id: string, input: Record<string, unknown>): Promise<unknown> {
  requireSameOrigin(request);
  const { account, schedule } = await ownedSchedule(request, id);
  if (schedule.status !== "active") throw new AppError("Конференция отменена", 409);
  const any = await db().prepare("SELECT 1 FROM schedule_sessions WHERE schedule_id = ? LIMIT 1").bind(id).first();
  if (schedule.recurrence === "once" && any) throw new AppError("Разовая конференция уже проведена", 409);
  const data = parseSchedule(input, schedule.timezone);
  if (data.recurrence === "once" && any) throw new AppError("Проведённую серию нельзя превратить в разовую", 409);
  if (data.recurrence === "once" && nextOccurrence({ start_date: data.startDate, start_time: data.startTime, timezone: data.timezone, recurrence: data.recurrence, weekdays: data.weekdays, duration_minutes: data.durationMinutes }) === null) throw new AppError("Выберите будущую дату и время");
  await db().prepare("UPDATE schedules SET title = ?, kind = ?, start_date = ?, start_time = ?, duration_minutes = ?, recurrence = ?, weekdays = ?, updated_at = ? WHERE id = ? AND owner_id = ?")
    .bind(data.title, data.kind, data.startDate, data.startTime, data.durationMinutes, data.recurrence, data.weekdays, Date.now(), id, account.id).run();
  return scheduleView(request, await scheduleById(id), account);
}

export async function cancelSchedule(request: Request, id: string): Promise<unknown> {
  requireSameOrigin(request);
  const { account } = await ownedSchedule(request, id);
  await db().prepare("UPDATE schedules SET status = 'cancelled', updated_at = ? WHERE id = ? AND owner_id = ?").bind(Date.now(), id, account.id).run();
  return scheduleView(request, await scheduleById(id), account);
}

export async function startSchedule(request: Request, id: string): Promise<unknown> {
  requireSameOrigin(request);
  mediaConfig();
  const { account, schedule } = await ownedSchedule(request, id);
  if (schedule.status !== "active") throw new AppError("Конференция отменена", 409);
  const origin = new URL(request.url).origin;
  if (schedule.active_room_id) {
    const room = await db().prepare("SELECT status FROM rooms WHERE id = ?").bind(schedule.active_room_id).first<{ status: string }>();
    if (room?.status === "open") return { roomUrl: `${origin}/r/${schedule.active_room_id}`, guestUrl: `${origin}/s/${id}` };
    throw new AppError("Конференция запускается. Попробуйте ещё раз через несколько секунд.", 409);
  }
  const recent = await db().prepare("SELECT COUNT(*) AS count FROM schedule_sessions ss JOIN schedules s ON s.id = ss.schedule_id WHERE s.owner_id = ? AND ss.started_at > ?").bind(account.id, Date.now() - 3600_000).first<{ count: number }>();
  if ((recent?.count || 0) >= 5) throw new AppError("Слишком много конференций за последний час", 429);
  const roomId = crypto.randomUUID();
  const now = Date.now();
  const claimed = await db().prepare("UPDATE schedules SET active_room_id = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND status = 'active' AND active_room_id IS NULL AND (recurrence != 'once' OR NOT EXISTS (SELECT 1 FROM schedule_sessions WHERE schedule_id = ?))")
    .bind(roomId, now, id, account.id, id).run();
  if (!claimed.meta.changes) throw new AppError("Конференция уже запущена или завершена", 409);
  let roomCreated = false;
  try {
    const hostSecretHash = await sha256(randomSecret());
    await db().prepare("INSERT INTO rooms (id, kind, host_secret_hash, status, created_at, schedule_id) VALUES (?, ?, ?, 'starting', ?, ?)")
      .bind(roomId, schedule.kind, hostSecretHash, now, id).run();
    roomCreated = true;
    await livekitRequest("RoomService", "CreateRoom", { name: roomId, empty_timeout: 600, departure_timeout: 60, max_participants: 50 }, roomId);
    let planned = currentOccurrence(schedule, now);
    if (schedule.recurrence === "once") planned = nextOccurrence(schedule, 0);
    if (planned !== null) {
      const existing = await db().prepare("SELECT 1 FROM schedule_sessions WHERE schedule_id = ? AND planned_start_at = ? LIMIT 1").bind(id, planned).first();
      if (existing) planned = null;
    }
    await db().batch([
      db().prepare("INSERT INTO schedule_sessions (room_id, schedule_id, planned_start_at, started_at) VALUES (?, ?, ?, ?)").bind(roomId, id, planned, now),
      db().prepare("UPDATE rooms SET status = 'open' WHERE id = ?").bind(roomId),
    ]);
    return { roomUrl: `${origin}/r/${roomId}`, guestUrl: `${origin}/s/${id}` };
  } catch (error) {
    try { await livekitRequest("RoomService", "DeleteRoom", { room: roomId }, roomId); } catch { /* Room may not exist. */ }
    if (roomCreated) await db().prepare("DELETE FROM rooms WHERE id = ?").bind(roomId).run();
    await db().prepare("UPDATE schedules SET active_room_id = NULL WHERE id = ? AND active_room_id = ?").bind(id, roomId).run();
    throw error;
  }
}

export async function scheduledOwner(request: Request, scheduleId: string): Promise<boolean> {
  const account = await getAccount(request);
  if (!account) return false;
  const schedule = await scheduleById(scheduleId);
  return schedule.owner_id === account.id;
}

export async function markScheduleEnded(roomId: string, scheduleId: string, endedAt: number): Promise<void> {
  await db().batch([
    db().prepare("UPDATE rooms SET status = 'ended', ended_at = ? WHERE id = ?").bind(endedAt, roomId),
    db().prepare("UPDATE schedule_sessions SET ended_at = ? WHERE room_id = ? AND ended_at IS NULL").bind(endedAt, roomId),
    db().prepare("UPDATE schedules SET active_room_id = NULL, updated_at = ? WHERE id = ? AND active_room_id = ?").bind(endedAt, scheduleId, roomId),
  ]);
}
