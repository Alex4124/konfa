import { env } from "cloudflare:workers";

export type RoomKind = "meeting" | "webinar";
export type Role = "host" | "speaker" | "viewer";
export type RoomRow = {
  id: string; kind: RoomKind; host_secret_hash: string; status: string;
  active_share_id: string | null; active_share_owner: string | null;
  recording_id: string | null; created_at: number; ended_at: number | null;
};
export type MemberRow = {
  id: string; room_id: string; name: string; role: Role;
  can_annotate: number; raised_hand: number; removed: number; created_at: number;
};
export type RecordingRow = {
  id: string; room_id: string; object_key: string;
  egress_id: string | null; status: string; started_at: number;
  ended_at: number | null; expires_at: number | null; last_checked_at: number | null;
};

export class AppError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export function db(): D1Database {
  if (!env.DB) throw new AppError("База данных пока не подключена", 503);
  return env.DB;
}

export function mediaConfig() {
  const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = env;
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    throw new AppError("Видеосвязь пока не настроена. Добавьте ключи LiveKit Cloud.", 503);
  }
  return { url: LIVEKIT_URL, key: LIVEKIT_API_KEY, secret: LIVEKIT_API_SECRET };
}

export function recordingConfig() {
  const { R2_S3_ENDPOINT, R2_S3_ACCESS_KEY, R2_S3_SECRET_KEY, R2_S3_BUCKET, PUBLIC_SITE_URL } = env;
  if (!R2_S3_ENDPOINT || !R2_S3_ACCESS_KEY || !R2_S3_SECRET_KEY || !R2_S3_BUCKET || !PUBLIC_SITE_URL || !env.BUCKET) {
    throw new AppError("Запись пока не настроена. Нужны доступ LiveKit к R2 и адрес сайта.", 503);
  }
  return { endpoint: R2_S3_ENDPOINT, accessKey: R2_S3_ACCESS_KEY, secretKey: R2_S3_SECRET_KEY, bucket: R2_S3_BUCKET, siteUrl: PUBLIC_SITE_URL };
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof AppError) return json({ error: error.message }, error.status);
  console.error(error);
  return json({ error: "Внутренняя ошибка сервиса" }, 500);
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch { throw new AppError("Некорректные данные запроса"); }
}

export function requiredString(value: unknown, label: string, max = 100): string {
  if (typeof value !== "string") throw new AppError(`Укажите ${label}`);
  const result = value.trim();
  if (!result || result.length > max) throw new AppError(`Укажите ${label} (не более ${max} символов)`);
  return result;
}

function base64url(bytes: Uint8Array): string {
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decode64(value: string): Uint8Array {
  const raw = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

async function signature(input: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input))));
}

export async function signToken(payload: Record<string, unknown>): Promise<string> {
  const { secret } = mediaConfig();
  const header = base64url(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = base64url(new TextEncoder().encode(JSON.stringify(payload)));
  const input = `${header}.${body}`;
  return `${input}.${await signature(input, secret)}`;
}

export async function verifyToken(token: string): Promise<Record<string, unknown>> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new AppError("Сессия недействительна", 401);
  const input = `${parts[0]}.${parts[1]}`;
  const expected = await signature(input, mediaConfig().secret);
  if (parts[2] !== expected) throw new AppError("Сессия недействительна", 401);
  let body: Record<string, unknown>;
  try { body = JSON.parse(new TextDecoder().decode(decode64(parts[1]))); }
  catch { throw new AppError("Сессия недействительна", 401); }
  if (typeof body.exp !== "number" || body.exp <= Math.floor(Date.now() / 1000)) throw new AppError("Сессия истекла", 401);
  return body;
}

export async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomSecret(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function roomById(id: string): Promise<RoomRow> {
  const room = await db().prepare("SELECT * FROM rooms WHERE id = ?").bind(id).first<RoomRow>();
  if (!room) throw new AppError("Комната не найдена", 404);
  return room;
}

export async function authorize(request: Request, roomId: string): Promise<MemberRow> {
  const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) throw new AppError("Войдите в комнату", 401);
  const claims = await verifyToken(token);
  if (claims.aud !== "confa" || claims.roomId !== roomId || typeof claims.memberId !== "string") throw new AppError("Нет доступа к комнате", 403);
  const member = await db().prepare("SELECT * FROM members WHERE id = ? AND room_id = ?").bind(claims.memberId, roomId).first<MemberRow>();
  if (!member || member.removed) throw new AppError("Доступ отозван", 403);
  return member;
}

export async function authorizeState(request: Request, roomId: string): Promise<MemberRow | null> {
  const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) throw new AppError("Нет доступа", 401);
  const claims = await verifyToken(token);
  if (claims.aud === "confa-egress" && claims.roomId === roomId) return null;
  return authorize(request, roomId);
}

export function requireHost(member: MemberRow): void {
  if (member.role !== "host") throw new AppError("Действие доступно только ведущему", 403);
}

export function grants(roomId: string, member: Pick<MemberRow, "role" | "can_annotate">): Record<string, unknown> {
  const presenter = member.role === "host" || member.role === "speaker";
  return {
    room: roomId, roomJoin: true, canSubscribe: true,
    canPublish: presenter, canPublishSources: presenter ? ["camera", "microphone", "screen_share", "screen_share_audio"] : [],
    canPublishData: member.role === "host" || Boolean(member.can_annotate),
  };
}

export async function joinToken(roomId: string, member: MemberRow): Promise<string> {
  const { key } = mediaConfig();
  const now = Math.floor(Date.now() / 1000);
  return signToken({ iss: key, sub: member.id, name: member.name, iat: now, nbf: now - 5, exp: now + 3600, video: grants(roomId, member) });
}

export async function appToken(roomId: string, memberId: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signToken({ aud: "confa", roomId, memberId, iat: now, exp: now + 24 * 3600 });
}

export async function egressToken(roomId: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signToken({ aud: "confa-egress", roomId, iat: now, exp: now + 8 * 3600 });
}

export async function recordingShareToken(recordingId: string): Promise<string> {
  return signToken({ aud: "confa-recording", recordingId, exp: 4102444800 });
}

export async function livekitRequest<T = Record<string, unknown>>(service: "RoomService" | "Egress", method: string, body: Record<string, unknown>, roomId?: string): Promise<T> {
  const { url, key } = mediaConfig();
  const now = Math.floor(Date.now() / 1000);
  const token = await signToken({
    iss: key, sub: "confa-server", iat: now, nbf: now - 5, exp: now + 300,
    video: { room: roomId, roomCreate: true, roomAdmin: true, roomRecord: true, roomList: true },
  });
  const endpoint = url.replace(/^wss:/, "https:").replace(/^ws:/, "http:").replace(/\/$/, "");
  const response = await fetch(`${endpoint}/twirp/livekit.${service}/${method}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const result = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    console.error("LiveKit API", method, response.status, result);
    throw new AppError("Медиасервис временно недоступен", 502);
  }
  return result as T;
}

export async function broadcast(roomId: string, event: Record<string, unknown>): Promise<void> {
  try {
    const raw = new TextEncoder().encode(JSON.stringify(event));
    let binary = "";
    for (const byte of raw) binary += String.fromCharCode(byte);
    await livekitRequest("RoomService", "SendData", { room: roomId, data: btoa(binary), kind: "RELIABLE", topic: "confa" }, roomId);
  } catch (error) {
    console.error("Realtime fanout failed; clients will refresh state", error);
  }
}
