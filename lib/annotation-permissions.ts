import type { Role, RoomKind, RoomState } from "@/lib/confa-types";

export type AccessMember = { id: string; role: Role; can_annotate: number | boolean };
export type AccessRoom = { annotationsEnabled: boolean; activeShareOwner: string | null };
export type AccessLevel = "host" | "presenter" | "allowed" | "paused" | "denied";

type MaybeMember = AccessMember | null | undefined;
type MaybeRoom = AccessRoom | null | undefined;

export function isShareOwner(member: Pick<AccessMember, "id"> | null | undefined, room: MaybeRoom): boolean {
  return Boolean(member && room?.activeShareOwner && room.activeShareOwner === member.id);
}

export function canModerate(member: MaybeMember, room: MaybeRoom): boolean {
  return member?.role === "host" || isShareOwner(member, room);
}

export function canAnnotate(member: MaybeMember, room: MaybeRoom): boolean {
  if (!member || !room) return false;
  return canModerate(member, room) || (room.annotationsEnabled && Boolean(member.can_annotate));
}

export function canChangeAnnotation(member: MaybeMember, room: MaybeRoom, authorId: string): boolean {
  if (!member || !canAnnotate(member, room)) return false;
  return authorId === member.id || canModerate(member, room);
}

export function accessLevel(member: MaybeMember, room: MaybeRoom): AccessLevel {
  if (!member) return "denied";
  if (member.role === "host") return "host";
  if (!room) return "denied";
  if (isShareOwner(member, room)) return "presenter";
  if (!member.can_annotate) return "denied";
  return room.annotationsEnabled ? "allowed" : "paused";
}

export function defaultCanAnnotate(kind: RoomKind, role: Role): boolean {
  return !(kind === "webinar" && role === "viewer");
}

export function canAnnotateAfterRoleChange(role: Role): boolean {
  return role !== "viewer";
}

export function accessRoomFromRow(row: { annotations_enabled: number | boolean; active_share_owner: string | null }): AccessRoom {
  return { annotationsEnabled: Boolean(row.annotations_enabled), activeShareOwner: row.active_share_owner || null };
}

export function accessRoomFromState(room: Pick<RoomState["room"], "annotationsEnabled" | "activeShareOwner">): AccessRoom {
  return { annotationsEnabled: Boolean(room.annotationsEnabled), activeShareOwner: room.activeShareOwner || null };
}
