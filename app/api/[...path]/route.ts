import { env } from "cloudflare:workers";
import {
  AppError, appToken, authorize, authorizeState, broadcast, db, egressToken,
  errorResponse, grants, joinToken, json, livekitRequest, mediaConfig,
  randomSecret, readJson, recordingConfig, recordingShareToken, requiredString, requireHost,
  roomById, sha256, verifyToken, type MemberRow, type RecordingRow, type RoomKind,
} from "@/lib/confa-server";

export const runtime = "edge";

function parts(request: Request): string[] {
  return new URL(request.url).pathname.split("/").filter(Boolean).slice(1);
}

async function roomState(request: Request, id: string): Promise<Response> {
  await authorizeState(request, id);
  const room = await roomById(id);
  const database = db();
  if (room.recording_id) await refreshRecording(room.recording_id);
  const [members, messages, annotations, recording] = await Promise.all([
    database.prepare("SELECT id, name, role, can_annotate, raised_hand, removed FROM members WHERE room_id = ? AND removed = 0").bind(id).all(),
    database.prepare("SELECT id, member_id, name, body, created_at FROM messages WHERE room_id = ? ORDER BY created_at DESC LIMIT 100").bind(id).all(),
    room.active_share_id
      ? database.prepare("SELECT id, author_id, kind, payload, created_at FROM annotations WHERE room_id = ? AND share_id = ? AND deleted = 0 ORDER BY created_at ASC LIMIT 500").bind(id, room.active_share_id).all()
      : Promise.resolve({ results: [] }),
    room.recording_id
      ? database.prepare("SELECT * FROM recordings WHERE id = ?").bind(room.recording_id).first<RecordingRow>()
      : Promise.resolve(null),
  ]);
  return json({
    room: { id, kind: room.kind, status: room.status, activeShareId: room.active_share_id, activeShareOwner: room.active_share_owner },
    members: members.results,
    messages: [...messages.results].reverse(),
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
  if (recording.status === "processing" && env.BUCKET && await env.BUCKET.head(recording.object_key)) {
    await database.prepare("UPDATE recordings SET status = 'ready', ended_at = COALESCE(ended_at, ?), expires_at = COALESCE(expires_at, ?) WHERE id = ?").bind(now, now + 30 * 86400_000, id).run();
    return;
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
  if (!env.BUCKET) throw new AppError("Хранилище недоступно", 503);
  const recording = await recordingByToken(token);
  if (!recording || recording.status !== "ready" || !recording.expires_at || recording.expires_at <= Date.now()) throw new AppError("Запись недоступна или срок ссылки истёк", 404);
  const head = await env.BUCKET.head(recording.object_key);
  if (!head) throw new AppError("Файл записи не найден", 404);
  const range = request.headers.get("Range");
  let offset = 0;
  let length = head.size;
  let status = 200;
  if (range) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (!match) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${head.size}` } });
    offset = Number(match[1]);
    const end = match[2] ? Math.min(Number(match[2]), head.size - 1) : head.size - 1;
    if (offset >= head.size || end < offset) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${head.size}` } });
    length = end - offset + 1;
    status = 206;
  }
  const object = await env.BUCKET.get(recording.object_key, { range: { offset, length } });
  if (!object) throw new AppError("Файл записи не найден", 404);
  const headers = new Headers({
    "Content-Type": "video/mp4", "Content-Length": String(length),
    "Accept-Ranges": "bytes", "Cache-Control": "private, no-store",
    "Content-Disposition": `inline; filename="confa-${recording.id}.mp4"`,
  });
  if (status === 206) headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${head.size}`);
  return new Response(object.body, { status, headers });
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
  if (path.length === 3 && path[2] === "annotations") return updateAnnotations(request, id, member);
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
    const role = isHost ? "host" : room.kind === "meeting" ? "speaker" : "viewer";
    const memberId = crypto.randomUUID();
    const now = Date.now();
    await db().prepare("INSERT INTO members (id, room_id, name, role, can_annotate, raised_hand, removed, created_at) VALUES (?, ?, ?, ?, ?, 0, 0, ?)").bind(memberId, id, name, role, isHost ? 1 : 0, now).run();
    member = { id: memberId, room_id: id, name, role, can_annotate: isHost ? 1 : 0, raised_hand: 0, removed: 0, created_at: now };
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

async function updateShare(request: Request, id: string, member: MemberRow): Promise<Response> {
  if (member.role === "viewer") throw new AppError("Зритель не может показывать экран", 403);
  const input = await readJson(request);
  const room = await roomById(id);
  if (input.action === "start") {
    if (room.active_share_id && room.active_share_owner !== member.id) {
      const active = await livekitRequest<{ participants?: Array<{ identity: string; tracks?: Array<{ source?: string }> }> }>("RoomService", "ListParticipants", { room: id }, id);
      const stillSharing = active.participants?.find((person) => person.identity === room.active_share_owner)?.tracks?.some((track) => track.source === "SCREEN_SHARE");
      if (stillSharing) throw new AppError("Другой участник уже показывает экран", 409);
    }
    const shareId = crypto.randomUUID();
    await db().prepare("UPDATE rooms SET active_share_id = ?, active_share_owner = ? WHERE id = ?").bind(shareId, member.id, id).run();
    await broadcast(id, { type: "state-changed" });
    return json({ shareId });
  }
  if (input.action === "stop") {
    if (room.active_share_owner !== member.id && member.role !== "host") throw new AppError("Нет доступа", 403);
    await db().prepare("UPDATE rooms SET active_share_id = NULL, active_share_owner = NULL WHERE id = ?").bind(id).run();
    await broadcast(id, { type: "state-changed" });
    return json({ stopped: true });
  }
  throw new AppError("Неизвестное действие");
}

function validPoint(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every((item) => typeof item === "number" && Number.isFinite(item) && item >= 0 && item <= 1);
}

function validateAnnotation(kind: string, payload: unknown): string {
  if (!["pen", "marker", "arrow", "rect", "text"].includes(kind) || !payload || typeof payload !== "object") throw new AppError("Некорректная пометка");
  const data = payload as Record<string, unknown>;
  if (typeof data.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(data.color)) throw new AppError("Некорректный цвет");
  if (kind === "text") {
    if (!validPoint(data.point) || typeof data.text !== "string" || !data.text.trim() || data.text.length > 140) throw new AppError("Некорректный текст");
  } else if (!Array.isArray(data.points) || data.points.length < 2 || data.points.length > 200 || !data.points.every(validPoint)) {
    throw new AppError("Некорректные координаты");
  }
  const encoded = JSON.stringify(data);
  if (encoded.length > 8000) throw new AppError("Пометка слишком большая");
  return encoded;
}

async function updateAnnotations(request: Request, id: string, member: MemberRow): Promise<Response> {
  if (member.role !== "host" && !member.can_annotate) throw new AppError("Ведущий не разрешил делать пометки", 403);
  const room = await roomById(id);
  if (!room.active_share_id) throw new AppError("Сейчас никто не показывает экран", 409);
  const input = await readJson(request);
  const database = db();
  if (input.action === "add") {
    const kind = requiredString(input.kind, "тип пометки", 20);
    const payload = validateAnnotation(kind, input.payload);
    const annotation = { id: crypto.randomUUID(), author_id: member.id, kind, payload, created_at: Date.now() };
    await database.prepare("INSERT INTO annotations (id, room_id, share_id, author_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(annotation.id, id, room.active_share_id, member.id, kind, payload, annotation.created_at).run();
    await broadcast(id, { type: "state-changed" });
    return json(annotation, 201);
  }
  if (input.action === "undo") {
    const last = await database.prepare("SELECT id FROM annotations WHERE room_id = ? AND share_id = ? AND author_id = ? AND deleted = 0 ORDER BY created_at DESC LIMIT 1").bind(id, room.active_share_id, member.id).first<{ id: string }>();
    if (last) await database.prepare("UPDATE annotations SET deleted = 1 WHERE id = ?").bind(last.id).run();
    await broadcast(id, { type: "state-changed" });
    return json({ deletedId: last?.id || null });
  }
  if (input.action === "erase") {
    const targetId = requiredString(input.targetId, "пометку", 100);
    const target = await database.prepare("SELECT author_id FROM annotations WHERE id = ? AND room_id = ? AND share_id = ? AND deleted = 0").bind(targetId, id, room.active_share_id).first<{ author_id: string }>();
    if (!target) throw new AppError("Пометка не найдена", 404);
    if (member.role !== "host" && target.author_id !== member.id) throw new AppError("Можно стереть только свою пометку", 403);
    await database.prepare("UPDATE annotations SET deleted = 1 WHERE id = ?").bind(targetId).run();
    await broadcast(id, { type: "state-changed" });
    return json({ deletedId: targetId });
  }
  if (input.action === "clear") {
    requireHost(member);
    await database.prepare("UPDATE annotations SET deleted = 1 WHERE room_id = ? AND share_id = ?").bind(id, room.active_share_id).run();
    await broadcast(id, { type: "state-changed" });
    return json({ cleared: true });
  }
  throw new AppError("Неизвестное действие");
}

async function updateMember(request: Request, id: string, targetId: string, actor: MemberRow): Promise<Response> {
  requireHost(actor);
  if (targetId === actor.id) throw new AppError("Нельзя изменить собственную роль");
  const input = await readJson(request);
  const target = await db().prepare("SELECT * FROM members WHERE id = ? AND room_id = ? AND removed = 0").bind(targetId, id).first<MemberRow>();
  if (!target) throw new AppError("Участник не найден", 404);
  if (input.action === "role") {
    if (input.role !== "speaker" && input.role !== "viewer") throw new AppError("Некорректная роль");
    await db().prepare("UPDATE members SET role = ?, raised_hand = 0 WHERE id = ?").bind(input.role, targetId).run();
    target.role = input.role;
  } else if (input.action === "annotation") {
    await db().prepare("UPDATE members SET can_annotate = ? WHERE id = ?").bind(input.enabled ? 1 : 0, targetId).run();
    target.can_annotate = input.enabled ? 1 : 0;
  } else if (input.action === "remove") {
    await db().prepare("UPDATE members SET removed = 1 WHERE id = ?").bind(targetId).run();
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
  try { await livekitRequest("RoomService", "UpdateParticipant", { room: id, identity: targetId, permission: grants(id, target) }, id); }
  catch (error) { console.error("Participant will receive new permissions on rejoin", error); }
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
