import {
  AppError, appToken, authorize, authorizeState, broadcast, db, egressToken,
  errorResponse, grants, joinToken, json, livekitRequest, mediaConfig,
  r2ObjectRequest, randomSecret, readJson, recordingConfig, recordingShareToken, requiredString, requireHost,
  roomById, sha256, verifyToken, type MemberRow, type RecordingRow, type Role, type RoomKind, type RoomRow,
} from "@/lib/confa-server";
import { translateAnnotation } from "@/lib/annotation-geometry";
import {
  accessRoomFromRow, canAnnotate, canAnnotateAfterRoleChange, canChangeAnnotation, canModerate, defaultCanAnnotate, type AccessRoom,
} from "@/lib/annotation-permissions";
import { isAnnotationKind, validateAnnotationPayload, validatePatch } from "@/lib/annotation-validate";
import {
  ADD_RATE_MAX, ADD_RATE_WINDOW_MS, ANNOTATION_CAP, ANNOTATION_READ_LIMIT,
  chunk, fitAnnotationOp, idList, parseUuid, placeholders,
} from "@/lib/annotation-wire";
import type { Annotation, AnnotationKind, AnnotationOp, AnnotationPayload } from "@/lib/confa-types";

export const runtime = "edge";

// Clients apply annotation ops directly; pre-op tabs catch up through their 3 s poll. Set to true to also send state-changed.
const LEGACY_ANNOTATION_REFRESH = false;

type ShareRequestRow = { id: string; room_id: string; member_id: string; status: string; created_at: number; updated_at: number };
type StoredAnnotation = Annotation & { room_id: string; share_id: string; deleted: number };
type OpBody<T = AnnotationOp> = T extends unknown ? Omit<T, "type" | "v" | "shareId" | "by"> : never;
type AnnotationScope = { roomId: string; shareId: string; member: MemberRow; access: AccessRoom; moderator: boolean };

const ROW_COLUMNS = "a.rowid AS seq, a.id, a.author_id, COALESCE(m.name, '') AS author_name, a.kind, a.payload, a.created_at";
const ROW_SOURCE = "FROM annotations a LEFT JOIN members m ON m.id = a.author_id";

async function connectedParticipant(roomId: string, memberId: string): Promise<boolean> {
  const list = await livekitRequest<{ participants?: Array<{ identity: string }> }>("RoomService", "ListParticipants", { room: roomId }, roomId);
  return Boolean(list.participants?.some((item) => item.identity === memberId));
}

async function setScreenPermission(roomId: string, member: MemberRow, approved: boolean): Promise<void> {
  if (!await connectedParticipant(roomId, member.id)) {
    if (approved) throw new AppError("Участник вышел из комнаты", 409);
    return;
  }
  await livekitRequest("RoomService", "UpdateParticipant", {
    room: roomId, identity: member.id, permission: grants(roomId, member, approved),
  }, roomId);
}

async function revokeScreenPermission(roomId: string, member: MemberRow): Promise<void> {
  try { await setScreenPermission(roomId, member, false); }
  catch (error) {
    // A failed permission update must not leave an approved guest connected.
    try { await livekitRequest("RoomService", "RemoveParticipant", { room: roomId, identity: member.id }, roomId); }
    catch { throw error; }
  }
}

function parts(request: Request): string[] {
  return new URL(request.url).pathname.split("/").filter(Boolean).slice(1);
}

async function roomState(request: Request, id: string): Promise<Response> {
  const actor = await authorizeState(request, id);
  const room = await roomById(id);
  const database = db();
  if (room.recording_id) await refreshRecording(room.recording_id);
  const [members, messages, shareRequests, annotations, recording] = await Promise.all([
    database.prepare("SELECT id, name, role, can_annotate, raised_hand, removed FROM members WHERE room_id = ? AND removed = 0").bind(id).all(),
    database.prepare("SELECT id, member_id, name, body, created_at FROM messages WHERE room_id = ? ORDER BY created_at DESC LIMIT 100").bind(id).all(),
    actor?.role === "host"
      ? database.prepare("SELECT s.id, s.member_id, m.name, s.status, s.created_at FROM share_requests s JOIN members m ON m.id = s.member_id WHERE s.room_id = ? AND m.removed = 0 AND s.status IN ('pending', 'approved', 'active') ORDER BY s.created_at ASC").bind(id).all()
      : actor
        ? database.prepare("SELECT s.id, s.member_id, m.name, s.status, s.created_at FROM share_requests s JOIN members m ON m.id = s.member_id WHERE s.room_id = ? AND s.member_id = ?").bind(id, actor.id).all()
        : Promise.resolve({ results: [] }),
    room.active_share_id
      ? database.prepare(`SELECT * FROM (SELECT ${ROW_COLUMNS} ${ROW_SOURCE} WHERE a.room_id = ? AND a.share_id = ? AND a.deleted = 0 ORDER BY a.rowid DESC LIMIT ${ANNOTATION_READ_LIMIT}) ORDER BY seq ASC`).bind(id, room.active_share_id).all()
      : Promise.resolve({ results: [] }),
    room.recording_id
      ? database.prepare("SELECT * FROM recordings WHERE id = ?").bind(room.recording_id).first<RecordingRow>()
      : Promise.resolve(null),
  ]);
  return json({
    room: { id, kind: room.kind, status: room.status, activeShareId: room.active_share_id, activeShareOwner: room.active_share_owner, annotationsEnabled: Boolean(room.annotations_enabled) },
    members: members.results,
    messages: [...messages.results].reverse(),
    shareRequests: shareRequests.results,
    annotations: annotations.results,
    recording: recording ? { status: recording.status, url: recording.status === "ready" && recording.expires_at && recording.expires_at > Date.now() ? `/recordings/${await recordingShareToken(recording.id)}` : null } : null,
  });
}

async function refreshRecording(id: string): Promise<void> {
  const database = db();
  const recording = await database.prepare("SELECT * FROM recordings WHERE id = ?").bind(id).first<RecordingRow>();
  if (!recording || !["processing", "recording", "starting"].includes(recording.status)) return;
  const now = Date.now();
  if (recording.last_checked_at && now - recording.last_checked_at < 8000) return;
  await database.prepare("UPDATE recordings SET last_checked_at = ? WHERE id = ?").bind(now, id).run();
  if (recording.status === "processing") {
    try {
      const object = await r2ObjectRequest("HEAD", recording.object_key);
      if (object.ok) {
        await database.prepare("UPDATE recordings SET status = 'ready', ended_at = COALESCE(ended_at, ?), expires_at = COALESCE(expires_at, ?) WHERE id = ?").bind(now, now + 30 * 86400_000, id).run();
        return;
      }
      if (object.status !== 404) console.error("Could not inspect R2 recording", object.status);
    } catch (error) { console.error("Could not inspect R2 recording", error); }
  }
  if (recording.egress_id) {
    try {
      const info = await livekitRequest<{ items?: Array<{ status?: string }> }>("Egress", "ListEgress", { egress_id: recording.egress_id }, recording.room_id);
      const status = info.items?.[0]?.status;
      if (status === "EGRESS_FAILED" || status === "EGRESS_ABORTED") await database.prepare("UPDATE recordings SET status = 'failed' WHERE id = ?").bind(id).run();
      if (status === "EGRESS_COMPLETE" && recording.status !== "processing") {
        await database.prepare("UPDATE recordings SET status = 'processing', ended_at = COALESCE(ended_at, ?), expires_at = COALESCE(expires_at, ?) WHERE id = ?").bind(now, now + 30 * 86400_000, id).run();
      }
    } catch (error) { console.error("Could not inspect egress", error); }
  }
}

async function get(request: Request): Promise<Response> {
  const path = parts(request);
  if (path[0] === "rooms" && path.length === 2) {
    const room = await roomById(path[1]);
    return json({ id: room.id, kind: room.kind, status: room.status });
  }
  if (path[0] === "rooms" && path.length === 3 && path[2] === "state") return roomState(request, path[1]);
  if (path[0] === "recordings" && path.length === 2) {
    const recording = await recordingByToken(path[1]);
    await refreshRecording(recording.id);
    const fresh = await db().prepare("SELECT * FROM recordings WHERE id = ?").bind(recording.id).first<RecordingRow>();
    if (!fresh || (fresh.expires_at && fresh.expires_at <= Date.now())) throw new AppError("Срок ссылки истёк", 404);
    return json({ status: fresh.status, createdAt: fresh.started_at, expiresAt: fresh.expires_at });
  }
  if (path[0] === "recordings" && path.length === 3 && path[2] === "file") return recordingFile(request, path[1]);
  throw new AppError("Адрес не найден", 404);
}

async function recordingFile(request: Request, token: string): Promise<Response> {
  const recording = await recordingByToken(token);
  if (!recording || recording.status !== "ready" || !recording.expires_at || recording.expires_at <= Date.now()) throw new AppError("Запись недоступна или срок ссылки истёк", 404);
  const object = await r2ObjectRequest("GET", recording.object_key, request.headers.get("Range"));
  if (object.status === 404) throw new AppError("Файл записи не найден", 404);
  if (object.status !== 200 && object.status !== 206 && object.status !== 416) throw new AppError("Хранилище временно недоступно", 502);
  const headers = new Headers({
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes", "Cache-Control": "private, no-store",
    "Content-Disposition": `inline; filename="confa-${recording.id}.mp4"`,
  });
  for (const name of ["Content-Length", "Content-Range"]) {
    const value = object.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(object.status === 416 ? null : object.body, { status: object.status, headers });
}

async function recordingByToken(token: string): Promise<RecordingRow> {
  const claims = await verifyToken(token);
  if (claims.aud !== "confa-recording" || typeof claims.recordingId !== "string") throw new AppError("Запись не найдена", 404);
  const recording = await db().prepare("SELECT * FROM recordings WHERE id = ?").bind(claims.recordingId).first<RecordingRow>();
  if (!recording) throw new AppError("Запись не найдена", 404);
  return recording;
}

async function post(request: Request): Promise<Response> {
  const path = parts(request);
  if (path[0] === "rooms" && path.length === 1) return createRoom(request);
  if (path[0] !== "rooms" || !path[1]) throw new AppError("Адрес не найден", 404);
  const id = path[1];
  if (path.length === 3 && path[2] === "join") return joinRoom(request, id);
  const member = await authorize(request, id);
  const room = await roomById(id);
  if (room.status !== "open") throw new AppError("Комната завершена", 410);
  if (path.length === 3 && path[2] === "message") return sendMessage(request, id, member);
  if (path.length === 3 && path[2] === "hand") return raiseHand(id, member);
  if (path.length === 3 && path[2] === "share") return updateShare(request, id, member);
  if (path.length === 3 && path[2] === "share-requests") return updateShareRequest(request, id, member);
  if (path.length === 3 && path[2] === "annotations") return updateAnnotations(request, id, member, room);
  if (path.length === 3 && path[2] === "recording") return updateRecording(request, id, member);
  if (path.length === 3 && path[2] === "end") return endRoom(id, member);
  if (path.length === 4 && path[2] === "members") return updateMember(request, id, path[3], member);
  throw new AppError("Адрес не найден", 404);
}

async function createRoom(request: Request): Promise<Response> {
  mediaConfig();
  const input = await readJson(request);
  if (input.kind !== "meeting" && input.kind !== "webinar") throw new AppError("Выберите тип комнаты");
  const kind = input.kind as RoomKind;
  const id = crypto.randomUUID();
  const hostSecret = randomSecret();
  const hostSecretHash = await sha256(hostSecret);
  const now = Date.now();
  const ip = request.headers.get("CF-Connecting-IP");
  const creatorHash = ip ? await sha256(`${ip}:${mediaConfig().secret}`) : null;
  const database = db();
  if (creatorHash) {
    const existing = await database.prepare("SELECT COUNT(*) AS count FROM rooms WHERE creator_hash = ? AND created_at > ?").bind(creatorHash, now - 3600_000).first<{ count: number }>();
    if ((existing?.count || 0) >= 5) throw new AppError("Слишком много комнат за последний час. Попробуйте позже.", 429);
  }
  await database.prepare("INSERT INTO rooms (id, kind, host_secret_hash, status, created_at, creator_hash) VALUES (?, ?, ?, 'open', ?, ?)").bind(id, kind, hostSecretHash, now, creatorHash).run();
  try {
    await livekitRequest("RoomService", "CreateRoom", { name: id, empty_timeout: 600, departure_timeout: 60, max_participants: 50 }, id);
  } catch (error) {
    await database.prepare("DELETE FROM rooms WHERE id = ?").bind(id).run();
    throw error;
  }
  const origin = new URL(request.url).origin;
  return json({ id, hostUrl: `${origin}/r/${id}#host=${hostSecret}`, guestUrl: `${origin}/r/${id}` }, 201);
}

async function joinRoom(request: Request, id: string): Promise<Response> {
  const room = await roomById(id);
  if (room.status !== "open") throw new AppError("Комната завершена", 410);
  const input = await readJson(request);
  const name = requiredString(input.name, "имя", 60);
  const isHost = typeof input.hostSecret === "string" && await sha256(input.hostSecret) === room.host_secret_hash;
  if (typeof input.hostSecret === "string" && !isHost) throw new AppError("Ссылка ведущего недействительна", 403);
  let member: MemberRow | null = null;
  const previous = request.headers.get("Authorization");
  if (previous) {
    try {
      const previousMember = await authorize(request, id);
      if (!isHost || previousMember.role === "host") member = previousMember;
    } catch { /* New session */ }
  }
  if (!member) {
    const role: Role = isHost ? "host" : room.kind === "meeting" ? "speaker" : "viewer";
    const memberId = crypto.randomUUID();
    const now = Date.now();
    const canAnnotateFlag = defaultCanAnnotate(room.kind, role) ? 1 : 0;
    await db().prepare("INSERT INTO members (id, room_id, name, role, can_annotate, raised_hand, removed, created_at) VALUES (?, ?, ?, ?, ?, 0, 0, ?)").bind(memberId, id, name, role, canAnnotateFlag, now).run();
    member = { id: memberId, room_id: id, name, role, can_annotate: canAnnotateFlag, raised_hand: 0, removed: 0, created_at: now };
  } else {
    if (member.role === "speaker") await revokeScreenPermission(id, member);
    await db().prepare("UPDATE share_requests SET status = 'cancelled', updated_at = ? WHERE member_id = ? AND status IN ('pending', 'approved', 'active')").bind(Date.now(), member.id).run();
    await db().prepare("UPDATE rooms SET active_share_id = NULL, active_share_owner = NULL WHERE id = ? AND active_share_owner = ?").bind(id, member.id).run();
  }
  const origin = new URL(request.url).origin;
  return json({
    member: { id: member.id, name: member.name, role: member.role, canAnnotate: Boolean(member.can_annotate) },
    sessionToken: await appToken(id, member.id),
    livekitToken: await joinToken(id, member),
    livekitUrl: mediaConfig().url,
    guestUrl: `${origin}/r/${id}`,
    kind: room.kind,
  });
}

async function sendMessage(request: Request, id: string, member: MemberRow): Promise<Response> {
  const input = await readJson(request);
  const body = requiredString(input.body, "сообщение", 1000);
  const message = { id: crypto.randomUUID(), member_id: member.id, name: member.name, body, created_at: Date.now() };
  await db().prepare("INSERT INTO messages (id, room_id, member_id, name, body, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(message.id, id, member.id, member.name, body, message.created_at).run();
  await broadcast(id, { type: "state-changed" });
  return json(message, 201);
}

async function raiseHand(id: string, member: MemberRow): Promise<Response> {
  const raised = member.raised_hand ? 0 : 1;
  await db().prepare("UPDATE members SET raised_hand = ? WHERE id = ?").bind(raised, member.id).run();
  await broadcast(id, { type: "state-changed" });
  return json({ raisedHand: Boolean(raised) });
}

async function updateShareRequest(request: Request, id: string, actor: MemberRow): Promise<Response> {
  const input = await readJson(request);
  const database = db();
  const now = Date.now();
  if (input.action === "request") {
    if (actor.role !== "speaker") throw new AppError("Показ экрана доступен только выступающим", 403);
    const previous = await database.prepare("SELECT status FROM share_requests WHERE member_id = ? AND room_id = ?").bind(actor.id, id).first<{ status: string }>();
    if (previous && ["pending", "approved", "active"].includes(previous.status)) throw new AppError("Запрос уже отправлен", 409);
    const requestId = crypto.randomUUID();
    const created = await database.prepare("INSERT INTO share_requests (member_id, room_id, id, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?) ON CONFLICT(member_id) DO UPDATE SET id = excluded.id, status = 'pending', created_at = excluded.created_at, updated_at = excluded.updated_at WHERE share_requests.status NOT IN ('pending', 'approved', 'active')").bind(actor.id, id, requestId, now, now).run();
    if (!created.meta.changes) throw new AppError("Запрос уже отправлен", 409);
    await broadcast(id, { type: "state-changed" });
    return json({ id: requestId, status: "pending" }, 201);
  }
  if (input.action === "cancel") {
    if (typeof input.requestId !== "string") throw new AppError("Укажите запрос");
    const current = await database.prepare("SELECT * FROM share_requests WHERE id = ? AND room_id = ? AND member_id = ?").bind(input.requestId, id, actor.id).first<ShareRequestRow>();
    if (!current || !["pending", "approved"].includes(current.status)) throw new AppError("Запрос уже неактуален", 409);
    if (current.status === "approved") await revokeScreenPermission(id, actor);
    const cancelled = await database.prepare("UPDATE share_requests SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('pending', 'approved')").bind(now, current.id).run();
    if (!cancelled.meta.changes) throw new AppError("Показ уже начался", 409);
    await broadcast(id, { type: "state-changed" });
    return json({ status: "cancelled" });
  }
  if (input.action === "revoke") {
    requireHost(actor);
    if (typeof input.requestId !== "string") throw new AppError("Укажите запрос");
    const approved = await database.prepare("SELECT * FROM share_requests WHERE id = ? AND room_id = ? AND status = 'approved'").bind(input.requestId, id).first<ShareRequestRow>();
    if (!approved) throw new AppError("Разрешение уже неактуально", 409);
    const target = await database.prepare("SELECT * FROM members WHERE id = ? AND room_id = ?").bind(approved.member_id, id).first<MemberRow>();
    if (target) await revokeScreenPermission(id, target);
    const revoked = await database.prepare("UPDATE share_requests SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'approved'").bind(now, approved.id).run();
    if (!revoked.meta.changes) throw new AppError("Показ уже начался", 409);
    await broadcast(id, { type: "state-changed" });
    return json({ status: "cancelled" });
  }
  if (input.action === "approve" || input.action === "deny") {
    requireHost(actor);
    if (typeof input.requestId !== "string") throw new AppError("Укажите запрос");
    const pending = await database.prepare("SELECT * FROM share_requests WHERE id = ? AND room_id = ? AND status = 'pending'").bind(input.requestId, id).first<ShareRequestRow>();
    if (!pending) throw new AppError("Запрос уже неактуален", 409);
    const target = await database.prepare("SELECT * FROM members WHERE id = ? AND room_id = ? AND removed = 0").bind(pending.member_id, id).first<MemberRow>();
    if (!target || target.role !== "speaker") throw new AppError("Участник больше не может показывать экран", 409);
    if (input.action === "deny") {
      const denied = await database.prepare("UPDATE share_requests SET status = 'denied', updated_at = ? WHERE id = ? AND status = 'pending'").bind(now, pending.id).run();
      if (!denied.meta.changes) throw new AppError("Запрос уже неактуален", 409);
      await broadcast(id, { type: "state-changed" });
      return json({ status: "denied" });
    }
    const room = await roomById(id);
    if (room.active_share_id) throw new AppError("Подождите завершения текущего показа", 409);
    const other = await database.prepare("SELECT id FROM share_requests WHERE room_id = ? AND status IN ('approved', 'active') LIMIT 1").bind(id).first();
    if (other) throw new AppError("Другой показ уже одобрен", 409);
    await setScreenPermission(id, target, true);
    try {
      const result = await database.prepare("UPDATE share_requests SET status = 'approved', updated_at = ? WHERE id = ? AND status = 'pending'").bind(now, pending.id).run();
      if (!result.meta.changes) throw new AppError("Запрос уже неактуален", 409);
    } catch (error) {
      await revokeScreenPermission(id, target);
      if (error instanceof AppError) throw error;
      throw new AppError("Другой показ уже одобрен", 409);
    }
    await broadcast(id, { type: "state-changed" });
    return json({ status: "approved" });
  }
  throw new AppError("Неизвестное действие");
}

async function updateShare(request: Request, id: string, member: MemberRow): Promise<Response> {
  if (member.role === "viewer") throw new AppError("Зритель не может показывать экран", 403);
  const input = await readJson(request);
  const room = await roomById(id);
  if (input.action === "start") {
    let approved: ShareRequestRow | null = null;
    if (member.role !== "host") {
      if (typeof input.requestId !== "string") throw new AppError("Сначала запросите разрешение ведущего", 403);
      approved = await db().prepare("SELECT * FROM share_requests WHERE id = ? AND member_id = ? AND room_id = ? AND status = 'approved'").bind(input.requestId, member.id, id).first<ShareRequestRow>();
      if (!approved) throw new AppError("Сначала запросите разрешение ведущего", 403);
    }
    if (room.active_share_id && room.active_share_owner !== member.id) {
      const active = await livekitRequest<{ participants?: Array<{ identity: string; tracks?: Array<{ source?: string }> }> }>("RoomService", "ListParticipants", { room: id }, id);
      const stillSharing = active.participants?.find((person) => person.identity === room.active_share_owner)?.tracks?.some((track) => track.source === "SCREEN_SHARE");
      if (stillSharing) throw new AppError("Другой участник уже показывает экран", 409);
      if (room.active_share_owner) {
        const previousOwner = await db().prepare("SELECT * FROM members WHERE id = ? AND room_id = ?").bind(room.active_share_owner, id).first<MemberRow>();
        if (previousOwner?.role === "speaker") await revokeScreenPermission(id, previousOwner);
        await db().prepare("UPDATE share_requests SET status = 'finished', updated_at = ? WHERE member_id = ? AND status = 'active'").bind(Date.now(), room.active_share_owner).run();
      }
      await db().prepare("UPDATE rooms SET active_share_id = NULL, active_share_owner = NULL WHERE id = ? AND active_share_id = ?").bind(id, room.active_share_id).run();
    }
    if (room.active_share_owner === member.id) throw new AppError("Вы уже показываете экран", 409);
    const shareId = crypto.randomUUID();
    const claimed = await db().prepare("UPDATE rooms SET active_share_id = ?, active_share_owner = ? WHERE id = ? AND active_share_id IS NULL AND status = 'open'").bind(shareId, member.id, id).run();
    if (!claimed.meta.changes) throw new AppError("Другой участник уже показывает экран", 409);
    if (approved) {
      const consumed = await db().prepare("UPDATE share_requests SET status = 'active', updated_at = ? WHERE id = ? AND member_id = ? AND status = 'approved'").bind(Date.now(), approved.id, member.id).run();
      if (!consumed.meta.changes) {
        await db().prepare("UPDATE rooms SET active_share_id = NULL, active_share_owner = NULL WHERE id = ? AND active_share_id = ?").bind(id, shareId).run();
        throw new AppError("Разрешение на показ больше не действует", 403);
      }
    }
    await broadcast(id, { type: "state-changed" });
    return json({ shareId });
  }
  if (input.action === "stop") {
    if (room.active_share_owner !== member.id && member.role !== "host") throw new AppError("Нет доступа", 403);
    if (room.active_share_owner) {
      const owner = await db().prepare("SELECT * FROM members WHERE id = ? AND room_id = ?").bind(room.active_share_owner, id).first<MemberRow>();
      if (owner?.role === "speaker") await revokeScreenPermission(id, owner);
      await db().prepare("UPDATE share_requests SET status = 'finished', updated_at = ? WHERE member_id = ? AND status = 'active'").bind(Date.now(), room.active_share_owner).run();
    }
    if (room.active_share_id) await db().prepare("UPDATE rooms SET active_share_id = NULL, active_share_owner = NULL WHERE id = ? AND active_share_id = ?").bind(id, room.active_share_id).run();
    await broadcast(id, { type: "state-changed" });
    return json({ stopped: true });
  }
  throw new AppError("Неизвестное действие");
}

function invalid(message = "Некорректная пометка"): AppError {
  return new AppError(message, 400, "invalid");
}

function publicRow(row: Annotation): Annotation {
  return { id: row.id, author_id: row.author_id, author_name: row.author_name, kind: row.kind, payload: row.payload, created_at: row.created_at, seq: row.seq };
}

function storedPayload(row: Annotation): AnnotationPayload {
  try {
    const payload: unknown = JSON.parse(row.payload);
    if (payload && typeof payload === "object" && !Array.isArray(payload)) return payload as AnnotationPayload;
  } catch { /* Reported below. */ }
  throw invalid();
}

function rowsOf<T>(result: D1Result<unknown> | undefined): T[] {
  return (result?.results ?? []) as T[];
}

async function broadcastAnnotationOp(roomId: string, op: AnnotationOp): Promise<void> {
  // Awaited on purpose: one author's sequential writes reach every client in commit order.
  await broadcast(roomId, fitAnnotationOp(op));
  if (LEGACY_ANNOTATION_REFRESH) await broadcast(roomId, { type: "state-changed" });
}

function publishOp(scope: AnnotationScope, body: OpBody): Promise<void> {
  return broadcastAnnotationOp(scope.roomId, { type: "annotations", v: 1, shareId: scope.shareId, by: scope.member.id, ...body });
}

async function updateAnnotations(request: Request, id: string, member: MemberRow, room: RoomRow): Promise<Response> {
  const input = await readJson(request);
  if (input.action === "setAccess") {
    requireHost(member);
    if (typeof input.enabled !== "boolean") throw new AppError("Некорректное разрешение");
    await db().prepare("UPDATE rooms SET annotations_enabled = ? WHERE id = ?").bind(input.enabled ? 1 : 0, id).run();
    await broadcast(id, { type: "state-changed" });
    return json({ annotationsEnabled: input.enabled });
  }
  const shareId = room.active_share_id;
  if (!shareId) throw new AppError("Сейчас никто не показывает экран", 409, "no-share");
  // Old tabs send no shareId; new clients pin every write to the share they drew on.
  if (input.shareId !== undefined && input.shareId !== shareId) throw new AppError("Демонстрация сменилась", 409, "share-changed");
  const access = accessRoomFromRow(room);
  if (!canAnnotate(member, access)) throw new AppError("Ведущий не разрешил вам делать пометки", 403, "forbidden");
  const scope: AnnotationScope = { roomId: id, shareId, member, access, moderator: canModerate(member, access) };
  if (input.action === "add") return addAnnotation(scope, input);
  if (input.action === "move") return moveAnnotation(scope, input);
  if (input.action === "edit") return editAnnotation(scope, input);
  if (input.action === "erase") return eraseAnnotations(scope, input);
  if (input.action === "restore") return restoreAnnotations(scope, input);
  if (input.action === "clear") return clearAnnotations(scope);
  if (input.action === "clearAuthor") return clearAuthorAnnotations(scope, input);
  if (input.action === "undo") return undoLastAnnotation(scope);
  throw new AppError("Неизвестное действие");
}

async function addAnnotation(scope: AnnotationScope, input: Record<string, unknown>): Promise<Response> {
  const { kind } = input;
  if (!isAnnotationKind(kind)) throw invalid();
  const checked = validateAnnotationPayload(kind, input.payload);
  if ("error" in checked) throw invalid(checked.error);
  // Old tabs send no id; new clients send their own UUID so a retried add is idempotent.
  const rowId = input.id === undefined || input.id === null ? crypto.randomUUID() : parseUuid(input.id);
  if (!rowId) throw invalid();
  return insertAnnotation(scope, kind, checked.encoded, rowId, true);
}

// Draft packets publish a stroke's id before its add commits, so another member may claim that id first. The author's row then
// takes an id derived from the requested one with the server secret: others cannot guess it, and the author's retries map to it.
async function fallbackAnnotationId(memberId: string, requested: string): Promise<string> {
  const hash = await sha256(`annotation:${memberId}:${requested}:${mediaConfig().secret}`);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

async function insertAnnotation(scope: AnnotationScope, kind: AnnotationKind, payload: string, rowId: string, mayRekey: boolean): Promise<Response> {
  const { roomId, shareId, member } = scope;
  const database = db();
  const now = Date.now();
  const inserted = await database.prepare("INSERT INTO annotations (id, room_id, share_id, author_id, kind, payload, deleted, created_at) SELECT ?1, ?2, ?3, ?4, ?5, ?6, 0, ?7 WHERE (SELECT COUNT(*) FROM annotations WHERE room_id = ?2 AND share_id = ?3 AND deleted = 0) < ?8 AND (SELECT COUNT(*) FROM annotations WHERE room_id = ?2 AND share_id = ?3 AND author_id = ?4 AND created_at > ?9) < ?10 ON CONFLICT(id) DO NOTHING")
    .bind(rowId, roomId, shareId, member.id, kind, payload, now, ANNOTATION_CAP, now - ADD_RATE_WINDOW_MS, ADD_RATE_MAX).run();
  if (inserted.meta.changes) {
    const row: Annotation = { id: rowId, author_id: member.id, author_name: member.name, kind, payload, created_at: now, seq: inserted.meta.last_row_id };
    await publishOp(scope, { op: "add", rows: [row] });
    return json({ row }, 201);
  }
  const [existing, counts] = await database.batch([
    database.prepare(`SELECT ${ROW_COLUMNS}, a.room_id, a.share_id, a.deleted ${ROW_SOURCE} WHERE a.id = ?`).bind(rowId),
    database.prepare("SELECT (SELECT COUNT(*) FROM annotations WHERE room_id = ?1 AND share_id = ?2 AND deleted = 0) AS live, (SELECT COUNT(*) FROM annotations WHERE room_id = ?1 AND share_id = ?2 AND author_id = ?3 AND created_at > ?4) AS recent").bind(roomId, shareId, member.id, now - ADD_RATE_WINDOW_MS),
  ]);
  const stored = rowsOf<StoredAnnotation>(existing)[0];
  if (stored) {
    const foreign = stored.room_id !== roomId || stored.share_id !== shareId || stored.author_id !== member.id;
    if (foreign && mayRekey) return insertAnnotation(scope, kind, payload, await fallbackAnnotationId(member.id, rowId), false);
    if (foreign || stored.kind !== kind) throw new AppError("Не удалось сохранить пометку — попробуйте ещё раз", 409, "conflict");
    if (stored.deleted) throw new AppError("Пометку уже удалили", 410, "gone");
    return json({ row: publicRow(stored) });
  }
  const { live = 0, recent = 0 } = rowsOf<{ live: number; recent: number }>(counts)[0] ?? {};
  if (live >= ANNOTATION_CAP) throw new AppError(`На экране уже ${ANNOTATION_CAP} пометок — очистите доску`, 409, "cap");
  if (recent >= ADD_RATE_MAX) throw new AppError("Слишком много пометок подряд — подождите пару секунд", 429, "rate");
  throw new AppError("Не удалось сохранить пометку — попробуйте ещё раз", 503, "retry");
}

async function changeableAnnotation(scope: AnnotationScope, targetId: unknown, denied: string): Promise<Annotation> {
  const id = parseUuid(targetId);
  if (!id) throw invalid("Укажите пометку");
  const target = await db().prepare(`SELECT ${ROW_COLUMNS} ${ROW_SOURCE} WHERE a.id = ? AND a.room_id = ? AND a.share_id = ? AND a.deleted = 0`).bind(id, scope.roomId, scope.shareId).first<Annotation>();
  if (!target) throw new AppError("Пометка не найдена", 404, "gone");
  if (!canChangeAnnotation(scope.member, scope.access, target.author_id)) throw new AppError(denied, 403, "forbidden");
  return target;
}

// Compare-and-set on the payload that was read, so concurrent moves and edits never overwrite each other silently.
async function replacePayload(scope: AnnotationScope, target: Annotation, payload: string): Promise<Annotation> {
  const database = db();
  const updated = await database.prepare("UPDATE annotations SET payload = ? WHERE id = ? AND room_id = ? AND share_id = ? AND deleted = 0 AND payload = ?").bind(payload, target.id, scope.roomId, scope.shareId, target.payload).run();
  if (!updated.meta.changes) {
    const deleted = await database.prepare("SELECT deleted FROM annotations WHERE id = ? AND room_id = ? AND share_id = ?").bind(target.id, scope.roomId, scope.shareId).first<number>("deleted");
    if (deleted === null || deleted) throw new AppError("Пометка не найдена", 404, "gone");
    throw new AppError("Пометку только что изменили — попробуйте ещё раз", 409, "conflict");
  }
  return { ...publicRow(target), payload };
}

async function moveAnnotation(scope: AnnotationScope, input: Record<string, unknown>): Promise<Response> {
  const { dx, dy } = input;
  if (typeof dx !== "number" || typeof dy !== "number" || !Number.isFinite(dx) || !Number.isFinite(dy) || Math.abs(dx) > 1 || Math.abs(dy) > 1) throw invalid("Некорректное смещение");
  const target = await changeableAnnotation(scope, input.targetId, "Можно перемещать только свои пометки");
  let moved: ReturnType<typeof translateAnnotation>;
  try { moved = translateAnnotation(storedPayload(target), dx, dy); }
  catch { throw invalid(); }
  const checked = validateAnnotationPayload(target.kind, moved.payload);
  if ("error" in checked) throw invalid(checked.error);
  const row = await replacePayload(scope, target, checked.encoded);
  await publishOp(scope, { op: "move", rows: [row] });
  return json({ row, dx: moved.dx, dy: moved.dy });
}

async function editAnnotation(scope: AnnotationScope, input: Record<string, unknown>): Promise<Response> {
  const target = await changeableAnnotation(scope, input.targetId, "Можно изменять только свои пометки");
  const checked = validatePatch(target.kind, storedPayload(target), input.patch);
  if ("error" in checked) throw invalid(checked.error);
  const row = await replacePayload(scope, target, checked.encoded);
  await publishOp(scope, { op: "edit", rows: [row] });
  return json({ row });
}

// Idempotent: ids that are already gone (or, for non-moderators, belong to others) are skipped, never 404.
// alreadyDeletedIds lists the skipped ids the caller could have erased, so a retry whose first attempt committed still succeeds.
async function eraseAnnotations(scope: AnnotationScope, input: Record<string, unknown>): Promise<Response> {
  const ids = idList(input.targetIds !== undefined ? input.targetIds : [input.targetId]);
  if (!ids) throw invalid("Укажите пометку");
  const database = db();
  const own = scope.moderator ? [] : [scope.member.id];
  const statements = chunk(ids).flatMap((part) => {
    const where = `room_id = ? AND share_id = ? AND id IN (${placeholders(part.length)})${own.length ? " AND author_id = ?" : ""}`;
    const values = [scope.roomId, scope.shareId, ...part, ...own];
    return [database.prepare(`SELECT id, deleted FROM annotations WHERE ${where}`).bind(...values), database.prepare(`UPDATE annotations SET deleted = 1 WHERE ${where} AND deleted = 0`).bind(...values)];
  });
  const results = await database.batch(statements);
  const found = results.filter((_, index) => index % 2 === 0).flatMap((result) => rowsOf<{ id: string; deleted: number }>(result));
  const deletedIds = found.filter((row) => !row.deleted).map((row) => row.id);
  const alreadyDeletedIds = found.filter((row) => row.deleted).map((row) => row.id);
  if (deletedIds.length) await publishOp(scope, { op: "erase", ids: deletedIds });
  return json({ deletedIds, alreadyDeletedIds });
}

async function restoreAnnotations(scope: AnnotationScope, input: Record<string, unknown>): Promise<Response> {
  const ids = idList(input.targetIds);
  if (!ids) throw invalid("Укажите пометку");
  const database = db();
  const { roomId, shareId } = scope;
  const own = scope.moderator ? [] : [scope.member.id];
  const parts = chunk(ids);
  // The cap subquery is evaluated once per statement, so a restore may overshoot the cap by less than one chunk.
  const updates = parts.map((part) => database.prepare(`UPDATE annotations SET deleted = 0 WHERE room_id = ? AND share_id = ? AND deleted = 1 AND id IN (${placeholders(part.length)})${own.length ? " AND author_id = ?" : ""} AND (SELECT COUNT(*) FROM annotations WHERE room_id = ? AND share_id = ? AND deleted = 0) < ?`)
    .bind(roomId, shareId, ...part, ...own, roomId, shareId, ANNOTATION_CAP));
  const selects = parts.map((part) => database.prepare(`SELECT ${ROW_COLUMNS} ${ROW_SOURCE} WHERE a.room_id = ? AND a.share_id = ? AND a.deleted = 0 AND a.id IN (${placeholders(part.length)})${own.length ? " AND a.author_id = ?" : ""}`)
    .bind(roomId, shareId, ...part, ...own));
  const results = await database.batch([...updates, ...selects]);
  const restored = results.slice(0, updates.length).reduce((sum, result) => sum + (result.meta.changes || 0), 0);
  const rows = results.slice(updates.length).flatMap((result) => rowsOf<Annotation>(result)).map(publicRow).sort((a, b) => a.seq - b.seq);
  if (restored) await publishOp(scope, { op: "restore", rows });
  else if (!rows.length) {
    const live = await database.prepare("SELECT COUNT(*) AS live FROM annotations WHERE room_id = ? AND share_id = ? AND deleted = 0").bind(roomId, shareId).first<number>("live");
    if ((live ?? 0) >= ANNOTATION_CAP) throw new AppError(`На экране уже ${ANNOTATION_CAP} пометок — очистите доску`, 409, "cap");
  }
  return json({ rows });
}

async function clearAnnotations(scope: AnnotationScope): Promise<Response> {
  if (!scope.moderator) throw new AppError("Очистить пометки может ведущий или докладчик", 403, "forbidden");
  const database = db();
  const [selected] = await database.batch([
    database.prepare("SELECT id, rowid AS seq FROM annotations WHERE room_id = ? AND share_id = ? AND deleted = 0 ORDER BY rowid ASC").bind(scope.roomId, scope.shareId),
    database.prepare("UPDATE annotations SET deleted = 1 WHERE room_id = ? AND share_id = ? AND deleted = 0").bind(scope.roomId, scope.shareId),
  ]);
  const cleared = rowsOf<{ id: string; seq: number }>(selected);
  const upToSeq = cleared.reduce((max, row) => Math.max(max, row.seq), 0);
  if (cleared.length) await publishOp(scope, { op: "clear", upToSeq });
  return json({ cleared: true, clearedIds: cleared.map((row) => row.id), upToSeq });
}

// A moderator's "erase everything by this author": broadcast as a plain erase so clients never over-delete.
async function clearAuthorAnnotations(scope: AnnotationScope, input: Record<string, unknown>): Promise<Response> {
  if (!scope.moderator) throw new AppError("Стирать чужие пометки может ведущий или докладчик", 403, "forbidden");
  const authorId = parseUuid(input.targetId);
  if (!authorId) throw invalid("Укажите участника");
  const database = db();
  const where = "room_id = ? AND share_id = ? AND author_id = ? AND deleted = 0";
  const [selected] = await database.batch([
    database.prepare(`SELECT id FROM annotations WHERE ${where} ORDER BY rowid ASC`).bind(scope.roomId, scope.shareId, authorId),
    database.prepare(`UPDATE annotations SET deleted = 1 WHERE ${where}`).bind(scope.roomId, scope.shareId, authorId),
  ]);
  const deletedIds = rowsOf<{ id: string }>(selected).map((row) => row.id);
  if (deletedIds.length) await publishOp(scope, { op: "erase", ids: deletedIds });
  return json({ deletedIds });
}

// Legacy action for tabs opened before client-side history existed.
async function undoLastAnnotation(scope: AnnotationScope): Promise<Response> {
  const database = db();
  const last = "SELECT id FROM annotations WHERE room_id = ? AND share_id = ? AND author_id = ? AND deleted = 0 ORDER BY rowid DESC LIMIT 1";
  const [selected] = await database.batch([
    database.prepare(last).bind(scope.roomId, scope.shareId, scope.member.id),
    database.prepare(`UPDATE annotations SET deleted = 1 WHERE id = (${last})`).bind(scope.roomId, scope.shareId, scope.member.id),
  ]);
  const deletedId = rowsOf<{ id: string }>(selected)[0]?.id ?? null;
  if (deletedId) await publishOp(scope, { op: "erase", ids: [deletedId] });
  return json({ deletedId });
}

async function updateMember(request: Request, id: string, targetId: string, actor: MemberRow): Promise<Response> {
  requireHost(actor);
  if (targetId === actor.id) throw new AppError("Нельзя изменить собственную роль");
  const input = await readJson(request);
  const target = await db().prepare("SELECT * FROM members WHERE id = ? AND room_id = ? AND removed = 0").bind(targetId, id).first<MemberRow>();
  if (!target) throw new AppError("Участник не найден", 404);
  if (input.action === "role") {
    if (input.role !== "speaker" && input.role !== "viewer") throw new AppError("Некорректная роль");
    if (input.role === "viewer") await revokeScreenPermission(id, { ...target, role: "viewer" });
    else await setScreenPermission(id, { ...target, role: "speaker" }, false);
    const canAnnotateFlag = canAnnotateAfterRoleChange(input.role) ? 1 : 0;
    await db().prepare("UPDATE members SET role = ?, raised_hand = 0, can_annotate = ? WHERE id = ?").bind(input.role, canAnnotateFlag, targetId).run();
    target.can_annotate = canAnnotateFlag;
    if (input.role === "viewer") {
      await db().prepare("UPDATE share_requests SET status = 'cancelled', updated_at = ? WHERE member_id = ? AND status IN ('pending', 'approved', 'active')").bind(Date.now(), targetId).run();
      await db().prepare("UPDATE rooms SET active_share_id = NULL, active_share_owner = NULL WHERE id = ? AND active_share_owner = ?").bind(id, targetId).run();
    }
    target.role = input.role;
  } else if (input.action === "annotation") {
    if (typeof input.enabled !== "boolean") throw new AppError("Некорректное разрешение");
    await db().prepare("UPDATE members SET can_annotate = ? WHERE id = ?").bind(input.enabled ? 1 : 0, targetId).run();
    target.can_annotate = input.enabled ? 1 : 0;
  } else if (input.action === "remove") {
    if (target.role === "speaker") await revokeScreenPermission(id, target);
    await db().prepare("UPDATE members SET removed = 1 WHERE id = ?").bind(targetId).run();
    await db().prepare("UPDATE share_requests SET status = 'cancelled', updated_at = ? WHERE member_id = ? AND status IN ('pending', 'approved', 'active')").bind(Date.now(), targetId).run();
    await db().prepare("UPDATE rooms SET active_share_id = NULL, active_share_owner = NULL WHERE id = ? AND active_share_owner = ?").bind(id, targetId).run();
    try { await livekitRequest("RoomService", "RemoveParticipant", { room: id, identity: targetId }, id); } catch (error) { console.error(error); }
    await broadcast(id, { type: "state-changed" });
    return json({ removed: true });
  } else if (input.action === "mute") {
    const info = await livekitRequest<{ participants?: Array<{ identity: string; tracks?: Array<{ sid: string; source?: string }> }> }>("RoomService", "ListParticipants", { room: id }, id);
    const track = info.participants?.find((item) => item.identity === targetId)?.tracks?.find((item) => item.source === "MICROPHONE");
    if (!track) throw new AppError("Микрофон участника уже выключен", 409);
    await livekitRequest("RoomService", "MutePublishedTrack", { room: id, identity: targetId, track_sid: track.sid, muted: true }, id);
    return json({ muted: true });
  } else throw new AppError("Неизвестное действие");
  await broadcast(id, { type: "state-changed" });
  return json({ role: target.role, canAnnotate: Boolean(target.can_annotate) });
}

async function updateRecording(request: Request, id: string, member: MemberRow): Promise<Response> {
  requireHost(member);
  const input = await readJson(request);
  const room = await roomById(id);
  const database = db();
  if (input.action === "start") {
    if (room.recording_id) {
      const previous = await database.prepare("SELECT status FROM recordings WHERE id = ?").bind(room.recording_id).first<{ status: string }>();
      if (previous && ["starting", "recording", "processing"].includes(previous.status)) throw new AppError("Запись уже идёт", 409);
    }
    const config = recordingConfig();
    const recordingId = crypto.randomUUID();
    const shareToken = await recordingShareToken(recordingId);
    const objectKey = `recordings/${recordingId}.mp4`;
    const now = Date.now();
    await database.prepare("INSERT INTO recordings (id, room_id, object_key, status, started_at) VALUES (?, ?, ?, 'starting', ?)").bind(recordingId, id, objectKey, now).run();
    const templateAccess = await egressToken(id);
    try {
      const result = await livekitRequest<{ egress_id: string }>("Egress", "StartEgress", {
        room_name: id,
        template: { custom_base_url: `${config.siteUrl.replace(/\/$/, "")}/egress/${id}?access=${encodeURIComponent(templateAccess)}` },
        outputs: [{ file: { filepath: objectKey, file_type: "MP4", disable_manifest: true } }],
        storage: { s3: { endpoint: config.endpoint, access_key: config.accessKey, secret: config.secretKey, bucket: config.bucket, region: "auto", force_path_style: true } },
      }, id);
      await database.prepare("UPDATE recordings SET status = 'recording', egress_id = ? WHERE id = ?").bind(result.egress_id, recordingId).run();
      await database.prepare("UPDATE rooms SET recording_id = ? WHERE id = ?").bind(recordingId, id).run();
      await broadcast(id, { type: "state-changed" });
      return json({ status: "recording", shareUrl: `${new URL(request.url).origin}/recordings/${shareToken}` });
    } catch (error) {
      await database.prepare("UPDATE recordings SET status = 'failed' WHERE id = ?").bind(recordingId).run();
      throw error;
    }
  }
  if (input.action === "stop") {
    if (!room.recording_id) throw new AppError("Запись не запущена", 409);
    const recording = await database.prepare("SELECT * FROM recordings WHERE id = ?").bind(room.recording_id).first<RecordingRow>();
    if (!recording || recording.status !== "recording" || !recording.egress_id) throw new AppError("Запись не запущена", 409);
    await livekitRequest("Egress", "StopEgress", { egress_id: recording.egress_id }, id);
    await database.prepare("UPDATE recordings SET status = 'processing', ended_at = ?, expires_at = ? WHERE id = ?").bind(Date.now(), Date.now() + 30 * 86400_000, recording.id).run();
    await broadcast(id, { type: "state-changed" });
    return json({ status: "processing" });
  }
  throw new AppError("Неизвестное действие");
}

async function endRoom(id: string, member: MemberRow): Promise<Response> {
  requireHost(member);
  const room = await roomById(id);
  if (room.recording_id) {
    const recording = await db().prepare("SELECT * FROM recordings WHERE id = ?").bind(room.recording_id).first<RecordingRow>();
    if (recording?.status === "recording" && recording.egress_id) {
      try {
        await livekitRequest("Egress", "StopEgress", { egress_id: recording.egress_id }, id);
        const now = Date.now();
        await db().prepare("UPDATE recordings SET status = 'processing', ended_at = ?, expires_at = ? WHERE id = ?").bind(now, now + 30 * 86400_000, recording.id).run();
      } catch (error) { console.error("Could not stop recording while ending room", error); }
    }
  }
  await db().prepare("UPDATE rooms SET status = 'ended', ended_at = ? WHERE id = ?").bind(Date.now(), id).run();
  try { await livekitRequest("RoomService", "DeleteRoom", { room: id }, id); } catch (error) { console.error(error); }
  return json({ ended: true });
}

export async function GET(request: Request): Promise<Response> {
  try { return await get(request); } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request): Promise<Response> {
  try { return await post(request); } catch (error) { return errorResponse(error); }
}
