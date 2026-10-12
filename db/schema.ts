import { sql } from "drizzle-orm";
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const rooms = sqliteTable("rooms", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  hostSecretHash: text("host_secret_hash").notNull(),
  status: text("status").notNull().default("open"),
  activeShareId: text("active_share_id"),
  activeShareOwner: text("active_share_owner"),
  annotationsEnabled: integer("annotations_enabled", { mode: "boolean" }).notNull().default(true),
  recordingId: text("recording_id"),
  createdAt: integer("created_at").notNull(),
  endedAt: integer("ended_at"),
  creatorHash: text("creator_hash"),
  scheduleId: text("schedule_id").references(() => schedules.id),
}, (table) => [index("rooms_creator_time_idx").on(table.creatorHash, table.createdAt)]);

export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  nickname: text("nickname").notNull(),
  nicknameKey: text("nickname_key").notNull(),
  email: text("email").notNull(),
  emailKey: text("email_key").notNull(),
  emailVerifiedAt: integer("email_verified_at"),
  passwordSalt: text("password_salt").notNull(),
  passwordHash: text("password_hash").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [uniqueIndex("accounts_nickname_key_idx").on(table.nicknameKey), uniqueIndex("accounts_email_key_idx").on(table.emailKey)]);

export const accountSessions = sqliteTable("account_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  accountId: text("account_id").notNull().references(() => accounts.id),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
}, (table) => [index("account_sessions_account_idx").on(table.accountId)]);

export const authAttempts = sqliteTable("auth_attempts", {
  key: text("key").primaryKey(),
  attempts: integer("attempts").notNull(),
  windowStart: integer("window_start").notNull(),
});

export const schedules = sqliteTable("schedules", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull().references(() => accounts.id),
  title: text("title").notNull(),
  kind: text("kind").notNull(),
  startDate: text("start_date").notNull(),
  startTime: text("start_time").notNull(),
  durationMinutes: integer("duration_minutes").notNull(),
  timezone: text("timezone").notNull(),
  recurrence: text("recurrence").notNull(),
  weekdays: integer("weekdays").notNull().default(0),
  status: text("status").notNull().default("active"),
  activeRoomId: text("active_room_id"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [index("schedules_owner_idx").on(table.ownerId, table.createdAt)]);

export const scheduleSessions = sqliteTable("schedule_sessions", {
  roomId: text("room_id").primaryKey().references(() => rooms.id),
  scheduleId: text("schedule_id").notNull().references(() => schedules.id),
  plannedStartAt: integer("planned_start_at"),
  startedAt: integer("started_at").notNull(),
  endedAt: integer("ended_at"),
}, (table) => [index("schedule_sessions_schedule_idx").on(table.scheduleId, table.startedAt)]);

export const members = sqliteTable("members", {
  id: text("id").primaryKey(),
  roomId: text("room_id").notNull().references(() => rooms.id),
  name: text("name").notNull(),
  role: text("role").notNull(),
  canAnnotate: integer("can_annotate", { mode: "boolean" }).notNull().default(true),
  raisedHand: integer("raised_hand", { mode: "boolean" }).notNull().default(false),
  boardDraw: integer("board_draw", { mode: "boolean" }).notNull().default(false),
  removed: integer("removed", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at").notNull(),
}, (table) => [index("members_room_idx").on(table.roomId)]);

export const shareRequests = sqliteTable("share_requests", {
  memberId: text("member_id").primaryKey().references(() => members.id),
  roomId: text("room_id").notNull().references(() => rooms.id),
  id: text("id").notNull(),
  status: text("status").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  index("share_requests_room_status_idx").on(table.roomId, table.status),
  uniqueIndex("one_approved_share_per_room_idx").on(table.roomId).where(sql`${table.status} IN ('approved', 'active')`),
]);

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  roomId: text("room_id").notNull().references(() => rooms.id),
  memberId: text("member_id").notNull(),
  name: text("name").notNull(),
  body: text("body").notNull(),
  createdAt: integer("created_at").notNull(),
}, (table) => [index("messages_room_time_idx").on(table.roomId, table.createdAt)]);

export const annotations = sqliteTable("annotations", {
  id: text("id").primaryKey(),
  roomId: text("room_id").notNull().references(() => rooms.id),
  shareId: text("share_id").notNull(),
  authorId: text("author_id").notNull(),
  kind: text("kind").notNull(),
  payload: text("payload").notNull(),
  deleted: integer("deleted", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at").notNull(),
}, (table) => [index("annotations_share_idx").on(table.roomId, table.shareId, table.createdAt)]);

export const recordings = sqliteTable("recordings", {
  id: text("id").primaryKey(),
  roomId: text("room_id").notNull().references(() => rooms.id),
  objectKey: text("object_key").notNull(),
  egressId: text("egress_id"),
  status: text("status").notNull(),
  startedAt: integer("started_at").notNull(),
  endedAt: integer("ended_at"),
  expiresAt: integer("expires_at"),
  lastCheckedAt: integer("last_checked_at"),
}, (table) => [index("recordings_room_idx").on(table.roomId)]);

// The teacher's workspace (board + materials), one per room; surfaces are annotation share ids (lib/workspace.ts).
export const workspaces = sqliteTable("workspaces", {
  roomId: text("room_id").primaryKey().references(() => rooms.id),
  id: text("id").notNull(),
  open: integer("open", { mode: "boolean" }).notNull().default(false),
  boardPage: integer("board_page").notNull().default(0),
  boardPages: integer("board_pages").notNull().default(1),
  boardCollapsed: integer("board_collapsed", { mode: "boolean" }).notNull().default(false),
  docCollapsed: integer("doc_collapsed", { mode: "boolean" }).notNull().default(false),
  docId: text("doc_id"),
  allDraw: integer("all_draw", { mode: "boolean" }).notNull().default(false),
  version: integer("version").notNull().default(1),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  // Where the teacher has scrolled the board to: band index + fraction of the band above the viewport top (lib/scroll-strip).
  boardPos: real("board_pos").notNull().default(0),
});

// Uploaded materials; page images live in the FILES bucket under rooms/<room>/docs/<id>/<page>.
export const documents = sqliteTable("documents", {
  id: text("id").primaryKey(),
  roomId: text("room_id").notNull().references(() => rooms.id),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  pageCount: integer("page_count").notNull(),
  pages: text("pages").notNull(),
  page: integer("page").notNull().default(0),
  status: text("status").notNull(),
  bytes: integer("bytes").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  pos: real("pos").notNull().default(0), // the teacher's scroll position in this material: page index + fraction
}, (table) => [index("documents_room_idx").on(table.roomId, table.createdAt)]);

// A counter per annotation surface, bumped with every change of its marks: clients name the revision they hold and are sent
// rows only when it moved.
export const surfaceRevs = sqliteTable("surface_revs", {
  roomId: text("room_id").notNull().references(() => rooms.id),
  shareId: text("share_id").notNull(),
  rev: integer("rev").notNull().default(0),
}, (table) => [primaryKey({ columns: [table.roomId, table.shareId] })]);
