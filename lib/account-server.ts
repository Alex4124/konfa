import { AppError, db, randomSecret, sha256 } from "@/lib/confa-server";

const COOKIE = "confa_account";
const SESSION_MS = 30 * 86400_000;
const ITERATIONS = 310_000;

export type Account = { id: string; name: string; nickname: string; email: string; email_verified_at: number | null };
type AccountRow = Account & { password_salt: string; password_hash: string };

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

async function passwordHash(password: string, salt: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: new Uint8Array(salt), hash: "SHA-256", iterations: ITERATIONS }, key, 256);
  return base64(new Uint8Array(bits));
}

export function validatePassword(value: unknown): string {
  if (typeof value !== "string" || value.length < 8 || value.length > 128) throw new AppError("Пароль должен содержать от 8 до 128 символов");
  return value;
}

export function validateNickname(value: unknown): { display: string; key: string } {
  if (typeof value !== "string") throw new AppError("Укажите никнейм");
  const display = value.trim();
  if (!/^[\p{L}\p{N}_.-]{3,30}$/u.test(display)) throw new AppError("Никнейм: 3–30 букв, цифр, точек, дефисов или подчёркиваний");
  return { display, key: display.toLocaleLowerCase("und") };
}

export function validateEmail(value: unknown): { display: string; key: string } {
  if (typeof value !== "string") throw new AppError("Укажите email");
  const display = value.trim();
  if (display.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(display)) throw new AppError("Укажите корректный email");
  return { display, key: display.toLowerCase() };
}

export function validateName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 60) throw new AppError("Укажите имя (до 60 символов)");
  return value.trim();
}

async function rateLimit(request: Request, scope: string, max: number, windowMs: number): Promise<void> {
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  const key = await sha256(`${scope}:${ip}`);
  const now = Date.now();
  const row = await db().prepare("SELECT attempts, window_start FROM auth_attempts WHERE key = ?").bind(key).first<{ attempts: number; window_start: number }>();
  if (row && now - row.window_start < windowMs && row.attempts >= max) throw new AppError("Слишком много попыток. Попробуйте позже.", 429);
  await db().prepare("INSERT INTO auth_attempts (key, attempts, window_start) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET attempts = CASE WHEN ? - window_start >= ? THEN 1 ELSE attempts + 1 END, window_start = CASE WHEN ? - window_start >= ? THEN ? ELSE window_start END")
    .bind(key, now, now, windowMs, now, windowMs, now).run();
}

export async function register(request: Request, input: Record<string, unknown>): Promise<{ account: Account; cookie: string }> {
  await rateLimit(request, "register", 5, 3600_000);
  const name = validateName(input.name);
  const nickname = validateNickname(input.nickname);
  const email = validateEmail(input.email);
  const password = validatePassword(input.password);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await passwordHash(password, salt);
  const id = crypto.randomUUID();
  const now = Date.now();
  try {
    await db().prepare("INSERT INTO accounts (id, name, nickname, nickname_key, email, email_key, password_salt, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, name, nickname.display, nickname.key, email.display, email.key, base64(salt), hash, now, now).run();
  } catch {
    throw new AppError("Никнейм или email уже заняты", 409);
  }
  const cookie = await createSession(request, id);
  return { account: { id, name, nickname: nickname.display, email: email.display, email_verified_at: null }, cookie };
}

export async function login(request: Request, input: Record<string, unknown>): Promise<{ account: Account; cookie: string }> {
  await rateLimit(request, "login", 10, 15 * 60_000);
  const nickname = validateNickname(input.nickname);
  const password = typeof input.password === "string" ? input.password : "";
  const row = await db().prepare("SELECT * FROM accounts WHERE nickname_key = ?").bind(nickname.key).first<AccountRow>();
  const salt = row ? fromBase64(row.password_salt) : new Uint8Array(16);
  const expected = row?.password_hash || base64(new Uint8Array(32));
  const actual = await passwordHash(password, salt);
  let difference = expected.length ^ actual.length;
  for (let i = 0; i < Math.max(expected.length, actual.length); i++) difference |= (expected.charCodeAt(i) || 0) ^ (actual.charCodeAt(i) || 0);
  if (!row || difference) throw new AppError("Неверный никнейм или пароль", 401);
  const cookie = await createSession(request, row.id);
  return { account: { id: row.id, name: row.name, nickname: row.nickname, email: row.email, email_verified_at: row.email_verified_at }, cookie };
}

function cookieValue(request: Request): string | null {
  const part = request.headers.get("Cookie")?.split(";").map((value) => value.trim()).find((value) => value.startsWith(`${COOKIE}=`));
  return part?.slice(COOKIE.length + 1) || null;
}

function sessionCookie(request: Request, token: string, maxAge: number): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

async function createSession(request: Request, accountId: string): Promise<string> {
  const token = randomSecret();
  const now = Date.now();
  await db().prepare("INSERT INTO account_sessions (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256(token), accountId, now, now + SESSION_MS).run();
  return sessionCookie(request, token, SESSION_MS / 1000);
}

export async function getAccount(request: Request, required = false): Promise<Account | null> {
  const token = cookieValue(request);
  if (token) {
    const account = await db().prepare("SELECT a.id, a.name, a.nickname, a.email, a.email_verified_at FROM account_sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ? AND s.expires_at > ?")
      .bind(await sha256(token), Date.now()).first<Account>();
    if (account) return account;
  }
  if (required) throw new AppError("Войдите в аккаунт", 401);
  return null;
}

export async function logout(request: Request): Promise<string> {
  const token = cookieValue(request);
  if (token) await db().prepare("DELETE FROM account_sessions WHERE token_hash = ?").bind(await sha256(token)).run();
  return sessionCookie(request, "", 0);
}

export async function changePassword(request: Request, input: Record<string, unknown>): Promise<string> {
  const account = await getAccount(request, true) as Account;
  const row = await db().prepare("SELECT password_salt, password_hash FROM accounts WHERE id = ?").bind(account.id).first<Pick<AccountRow, "password_salt" | "password_hash">>();
  if (!row || typeof input.currentPassword !== "string" || await passwordHash(input.currentPassword, fromBase64(row.password_salt)) !== row.password_hash) throw new AppError("Текущий пароль неверен", 403);
  const next = validatePassword(input.newPassword);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  await db().batch([
    db().prepare("UPDATE accounts SET password_salt = ?, password_hash = ?, updated_at = ? WHERE id = ?").bind(base64(salt), await passwordHash(next, salt), Date.now(), account.id),
    db().prepare("DELETE FROM account_sessions WHERE account_id = ?").bind(account.id),
  ]);
  return createSession(request, account.id);
}

export function requireSameOrigin(request: Request): void {
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) throw new AppError("Недопустимый источник запроса", 403);
}
