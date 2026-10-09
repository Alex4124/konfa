export type RoomKind = "meeting" | "webinar";
export type Role = "host" | "speaker" | "viewer";
export type Point = [number, number];
export type AnnotationKind = "pen" | "line" | "arrow" | "dashed" | "marker" | "rect" | "circle" | "triangle" | "hexagon" | "text";
export type Tool = AnnotationKind | "eraser" | "move" | "laser"; // laser is never stored
export type UiTool = Tool | "view";
export type LaserStyle = "laser" | "ink";
export type AnnotationPayload = {
  color: string; points?: Point[]; point?: Point;
  strokeWidth?: number; // int 1..24 reference units (px at 720 px frame height), non-text only
  fa?: number; // frame aspect (w/h) at draw time
  text?: string; lines?: string[]; // raw text and author-wrapped lines rendered verbatim
  fontSize?: number; // int 10..72 reference units
  maxWidth?: number; // 0.05..1 of frame width
  w?: number; h?: number; // text plate extent incl. padding, fractions of the frame
};
// seq = D1 rowid; author_name = COALESCE(members.name, '')
export type Annotation = { id: string; author_id: string; author_name: string; kind: AnnotationKind; payload: string; created_at: number; seq: number };
// server -> clients, topic "confa", accepted only when participant === undefined
export type AnnotationOp = { type: "annotations"; v: 1; shareId: string; by: string } & (
  | { op: "add" | "move" | "edit" | "restore"; rows: Annotation[] }
  | { op: "erase"; ids: string[] }
  | { op: "clear"; upToSeq: number }
  | { op: "resync" }
);
// client -> peers, topic "confa-annotation-draft"; live = lossy, end/cancel = reliable
export type DraftPacketV2 = {
  v: 2; shareId: string; strokeId: string; seq: number; phase: "live" | "end" | "cancel";
  kind: AnnotationKind | "laser"; style?: LaserStyle; color?: string; strokeWidth?: number;
  from?: number; points?: Point[]; moveOf?: string; dx?: number; dy?: number;
};
export type Member = { id: string; name: string; role: Role; can_annotate: number; raised_hand: number; removed: number; board_draw?: number };
export type Message = { id: string; member_id: string; name: string; body: string; created_at: number };
export type ShareRequest = { id: string; member_id: string; name: string; status: "pending" | "approved" | "active" | "denied" | "cancelled" | "finished"; created_at: number };
export type DocumentKind = "pdf" | "image" | "office";
// The current material of the workspace; surface = annotation share id of its current page, token = signed page-image access.
export type WorkspaceDoc = { id: string; name: string; kind: DocumentKind; pageCount: number; page: number; pages: Array<[number, number]>; surface: string; token: string };
export type WorkspaceDocument = { id: string; name: string; kind: DocumentKind; pageCount: number; createdAt: number };
// The teacher's workspace as the server reports it; boardSurface = annotation share id of the current board sheet.
export type WorkspaceView = {
  id: string; open: boolean; version: number;
  boardPage: number; boardPages: number; boardSurface: string;
  boardCollapsed: boolean; docCollapsed: boolean; allDraw: boolean;
  doc: WorkspaceDoc | null;
  documents?: WorkspaceDocument[]; // host only
};
export type RoomState = {
  room: { id: string; kind: RoomKind; status: string; activeShareId: string | null; activeShareOwner: string | null; annotationsEnabled: boolean };
  members: Member[];
  messages: Message[];
  shareRequests: ShareRequest[];
  annotations: Annotation[];
  recording: { status: string; url: string | null } | null;
  workspace?: WorkspaceView | null;
  boardAnnotations?: Annotation[]; // rows of workspace.boardSurface
  docAnnotations?: Annotation[]; // rows of workspace.doc.surface
};
