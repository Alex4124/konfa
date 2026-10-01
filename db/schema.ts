import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
}, (table) => [index("rooms_creator_time_idx").on(table.creatorHash, table.createdAt)]);

export const members = sqliteTable("members", {
  id: text("id").primaryKey(),
  roomId: text("room_id").notNull().references(() => rooms.id),
  name: text("name").notNull(),
  role: text("role").notNull(),
  canAnnotate: integer("can_annotate", { mode: "boolean" }).notNull().default(true),
  raisedHand: integer("raised_hand", { mode: "boolean" }).notNull().default(false),
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
