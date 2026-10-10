import type { DocumentKind, Role, RoomState, WorkspaceDocument, WorkspaceView } from "@/lib/confa-types";
import { EMPTY_CONTEXT, type SyncContext } from "./annotation-sync.ts";

// The teacher's workspace: an endless white board and a material (PDF, images, office files rendered to page images), each a
// column the teacher scrolls (lib/scroll-strip). The board is cut into 16:9 bands; every band and every material page is an
// annotation surface: its id is the annotations.share_id of its marks.

export const MAX_BOARD_BANDS = 200;
export const BOARD_ASPECT = 16 / 9;
export const BOARD_GRID_COLUMNS = 32; // 18 rows to a band, so the grid runs unbroken across bands
export const STUDENT_REACH_BANDS = 4; // below the top of the teacher's window: what a tall, narrow window shows
export const DOC_GAP = 0.012; // between material pages, in strip widths
export const MAX_DOC_PAGES = 100;
export const MAX_ROOM_DOCS = 20;
export const MAX_PAGE_BYTES = 4 * 1024 * 1024;
export const MAX_CONVERT_BYTES = 50 * 1024 * 1024;
export const MAX_SOURCE_BYTES = 200 * 1024 * 1024; // what the teacher's browser opens at all
export const ROOM_FILES_QUOTA = 300 * 1024 * 1024;
export const TOTAL_FILES_QUOTA = 8 * 1024 * 1024 * 1024;
export const ROOM_ANNOTATION_CAP = 20_000;
export const PAGE_LONG_SIDE = 2000;
export const MAX_PAGE_SIDE = 10_000;
export const MAX_DOC_NAME = 120;
export const UPLOAD_STALE_MS = 3600_000; // an upload that never finished stops counting and is purged
export const DOC_TOKEN_WINDOW_S = 6 * 3600;
export const BOARD_PIXEL_WIDTH = 3200; // what the board counts as its native width (the zoom limit, maxScaleFor)
export const IMAGE_TYPES = ["image/webp", "image/jpeg", "image/png"] as const;
export const OFFICE_EXTENSIONS = ["pptx", "ppt", "odp", "docx", "doc", "odt", "rtf"] as const;
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp"] as const;

export type PageImageType = (typeof IMAGE_TYPES)[number];
export type OfficeExtension = (typeof OFFICE_EXTENSIONS)[number];
export type Surface = { kind: "board"; workspaceId: string; page: number } | { kind: "doc"; docId: string; page: number };
export type WorkspaceRow = {
  room_id: string; id: string; open: number; board_page: number; board_pages: number;
  board_collapsed: number; doc_collapsed: number; doc_id: string | null; all_draw: number;
  version: number; created_at: number; updated_at: number; board_pos: number;
};
export type DocumentRow = {
  id: string; room_id: string; name: string; kind: DocumentKind; page_count: number; pages: string;
  page: number; status: "uploading" | "ready" | "deleted" | "purged"; bytes: number; created_at: number; pos: number;
};
type WorkspaceFields = Pick<WorkspaceRow, "open" | "board_page" | "board_pages" | "board_pos" | "board_collapsed" | "doc_collapsed" | "doc_id" | "all_draw">;
// quiet: the teacher's scroll position — stored without a new version or a broadcast (peers get it over the data channel).
// clearBoard: every mark of the board goes with this change.
export type WorkspaceChange = { set: Partial<WorkspaceFields>; docPos?: { docId: string; pos: number }; quiet?: boolean; clearBoard?: boolean };
export type WorkspaceRejection = { error: string; status: number };
export type BoardMember = { role: Role; board_draw?: number | boolean | null };
// What the host changed locally before the server confirmed it; version = the server version the change produced (null while in flight).
export type WorkspacePatch = Partial<Pick<WorkspaceView, "open" | "boardCollapsed" | "docCollapsed" | "allDraw">>;
export type PendingWorkspace = { patch: WorkspacePatch; version: number | null };
export type Stage = "workspace" | "share" | "grid";
export type StageChoice = "workspace" | "share";
export type PaneMode = "pane" | "rail" | "hidden";
export type WorkspaceLayout = { orientation: "row" | "column"; board: PaneMode; doc: PaneMode; grid: boolean };
export type UploadKind = "pdf" | "image" | "office";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SURFACE = /^([bd]):([0-9a-f-]{36}):(0|[1-9][0-9]{0,2})$/;

// Surfaces

export function boardSurface(workspaceId: string, page: number): string {
  return `b:${workspaceId}:${page}`;
}

export function docSurface(docId: string, page: number): string {
  return `d:${docId}:${page}`;
}

export function parseSurface(value: unknown): Surface | null {
  if (typeof value !== "string") return null;
  const match = SURFACE.exec(value);
  if (!match || !UUID.test(match[2])) return null;
  const page = Number(match[3]);
  if (match[1] === "b") return page < MAX_BOARD_BANDS ? { kind: "board", workspaceId: match[2], page } : null;
  return page < MAX_DOC_PAGES ? { kind: "doc", docId: match[2], page } : null;
}

// Which sync owns an op or a draft: by prefix only, so marks for the next page are journaled before its snapshot arrives.
export function surfaceKind(shareId: string): "board" | "doc" | "share" {
  return shareId.startsWith("b:") ? "board" : shareId.startsWith("d:") ? "doc" : "share";
}

export const acceptsShare = (shareId: string) => surfaceKind(shareId) === "share";

// share_id range of all bands of one board (':' + 1 is ';'): for SQL `share_id >= from AND share_id < to` and prefix checks.
export function boardRange(workspaceId: string): { from: string; to: string } {
  return { from: `b:${workspaceId}:`, to: `b:${workspaceId};` };
}

// Permissions

// The teacher always; a student when called to the board or while «Рисуют все ученики» is on.
export function canAnnotateBoard(member: BoardMember | null | undefined, workspace: { allDraw: boolean } | null | undefined): boolean {
  if (!member || !workspace) return false;
  return member.role === "host" || workspace.allDraw || Boolean(member.board_draw);
}

export function canModerateBoard(member: Pick<BoardMember, "role"> | null | undefined): boolean {
  return member?.role === "host";
}

// The last band a student may draw on: the bands in use and what the teacher's window shows (the teacher may have scrolled on
// to clean paper). Never further, so a student cannot stretch everyone's board band by band. The teacher has no limit.
export function studentBandLimit(row: Pick<WorkspaceRow, "board_pages" | "board_pos">): number {
  const shown = Math.floor(Number.isFinite(row.board_pos) ? Math.max(0, row.board_pos) : 0) + STUDENT_REACH_BANDS;
  return Math.min(MAX_BOARD_BANDS - 1, Math.max(row.board_pages - 1, shown));
}

// The sync context of one workspace surface: who may draw there right now, and whose names to show.
export function workspaceContext(state: RoomState | null, selfId: string | null, shareId: string | null): SyncContext {
  const workspace = state?.workspace;
  if (!state || !workspace) return { ...EMPTY_CONTEXT, selfId };
  const members = new Map(state.members.map((member) => [member.id, member]));
  return {
    shareId,
    selfId,
    canAnnotate: (identity) => canAnnotateBoard(members.get(identity), workspace),
    canModerate: (identity) => canModerateBoard(members.get(identity)),
    nameOf: (identity) => members.get(identity)?.name || undefined,
  };
}

// Workspace changes (server)

const STALE_TAB = { error: "Доска обновилась — перезагрузите страницу", status: 409 } as const;
const round4 = (value: number) => Math.round(value * 1e4) / 1e4;

export function clampPage(page: number, count: number): number {
  return Math.max(0, Math.min(Math.max(1, count) - 1, Number.isFinite(page) ? Math.trunc(page) : 0));
}

// One host action on the workspace row. `doc` is the document the action names (docSelect, docDelete) or the current one (view).
export function workspaceUpdate(row: WorkspaceRow, input: Record<string, unknown>, doc: Pick<DocumentRow, "id" | "page_count" | "status"> | null): WorkspaceChange | WorkspaceRejection {
  switch (input.action) {
    case "open":
      return { set: { open: 1 } };
    case "close":
      return { set: { open: 0 } };
    case "view": {
      const pos = typeof input.pos === "number" && Number.isFinite(input.pos) ? round4(input.pos) : null;
      if (input.part === "board") {
        if (pos === null || pos < 0 || pos >= MAX_BOARD_BANDS) return { error: "Некорректная позиция", status: 400 };
        return { set: { board_pos: pos, board_page: Math.floor(pos) }, quiet: true };
      }
      if (input.part !== "doc") return { error: "Некорректное действие", status: 400 };
      if (!doc || !row.doc_id || doc.id !== row.doc_id || doc.status !== "ready") return { error: "Материал не открыт", status: 409 };
      if (pos === null || pos < 0 || pos > doc.page_count) return { error: "Некорректная позиция", status: 400 };
      return { set: {}, docPos: { docId: doc.id, pos: Math.min(pos, doc.page_count - 1e-4) }, quiet: true };
    }
    case "boardClear":
      return { set: { board_pages: 1 }, clearBoard: true };
    // What tabs opened before the scrolling workspace still send.
    case "boardPage":
    case "addBoardPage":
    case "docPage":
      return STALE_TAB;
    case "collapse": {
      if ((input.part !== "board" && input.part !== "doc") || typeof input.collapsed !== "boolean") return { error: "Некорректное действие", status: 400 };
      return { set: input.part === "board" ? { board_collapsed: input.collapsed ? 1 : 0 } : { doc_collapsed: input.collapsed ? 1 : 0 } };
    }
    case "allDraw":
      if (typeof input.enabled !== "boolean") return { error: "Некорректное разрешение", status: 400 };
      return { set: { all_draw: input.enabled ? 1 : 0 } };
    case "docSelect":
      if (!doc || doc.id !== input.docId || doc.status !== "ready") return { error: "Материал не найден", status: 404 };
      return { set: { doc_id: doc.id, doc_collapsed: 0 } };
    case "docClose":
      return { set: { doc_id: null } };
    case "docDelete":
      if (!doc || doc.id !== input.docId || doc.status === "deleted" || doc.status === "purged") return { error: "Материал не найден", status: 404 };
      return { set: row.doc_id === doc.id ? { doc_id: null } : {} };
    default:
      return { error: "Неизвестное действие", status: 400 };
  }
}

export function parsePages(text: string, count: number): Array<[number, number]> | null {
  try { return validatePageSizes(JSON.parse(text), count); }
  catch { return null; }
}

const position = (value: unknown, count: number) => (typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(value, count - 1e-4)) : 0);

export function toWorkspaceView(row: WorkspaceRow, doc: (DocumentRow & { token: string }) | null, documents?: WorkspaceDocument[]): WorkspaceView {
  const boardPages = Math.max(1, Math.min(MAX_BOARD_BANDS, row.board_pages));
  const boardPos = position(row.board_pos, MAX_BOARD_BANDS);
  const boardPage = clampPage(boardPos, boardPages);
  const pages = doc && doc.status === "ready" ? parsePages(doc.pages, doc.page_count) : null;
  const docPos = doc && pages ? position(doc.pos, pages.length) : 0;
  const docPage = Math.floor(docPos);
  return {
    id: row.id, open: Boolean(row.open), version: row.version,
    boardPos, boardPages,
    boardCollapsed: Boolean(row.board_collapsed), docCollapsed: Boolean(row.doc_collapsed), allDraw: Boolean(row.all_draw),
    boardPage, boardSurface: boardSurface(row.id, boardPage),
    doc: doc && pages ? { id: doc.id, name: doc.name, kind: doc.kind, pageCount: pages.length, pos: docPos, pages, token: doc.token, page: docPage, surface: docSurface(doc.id, docPage) } : null,
    ...(documents ? { documents } : {}),
  };
}

// Signed page-image links expire on a fixed window, so the token (and the state key) stays the same between polls.
export function docTokenExp(nowSeconds: number, window = DOC_TOKEN_WINDOW_S): number {
  return (Math.floor(nowSeconds / window) + 2) * window;
}

// Workspace changes (client)

export function applyWorkspacePatch(view: WorkspaceView, patch: WorkspacePatch): WorkspaceView {
  return {
    ...view,
    open: patch.open ?? view.open,
    boardCollapsed: patch.boardCollapsed ?? view.boardCollapsed,
    docCollapsed: patch.docCollapsed ?? view.docCollapsed,
    allDraw: patch.allDraw ?? view.allDraw,
  };
}

// The host sees their change at once; the server view wins once it reports the version the change produced.
export function mergeWorkspace(server: WorkspaceView | null | undefined, pending: PendingWorkspace | null): WorkspaceView | null {
  if (!server) return null;
  if (!pending || (pending.version !== null && server.version >= pending.version)) return server;
  return applyWorkspacePatch(server, pending.patch);
}

// Layout and stage

// Side by side when the area is clearly wider than tall; a collapsed part becomes a rail; students never see an empty material.
export function workspaceLayout(input: { width: number; height: number; boardCollapsed: boolean; docCollapsed: boolean; hasDoc: boolean; isHost: boolean }): WorkspaceLayout {
  const orientation = input.width <= 0 || input.height <= 0 || input.width >= input.height * 1.15 ? "row" : "column";
  const board: PaneMode = input.boardCollapsed ? "rail" : "pane";
  const doc: PaneMode = !input.hasDoc && !input.isHost ? "hidden" : input.docCollapsed ? "rail" : "pane";
  return { orientation, board, doc, grid: board !== "pane" && doc !== "pane" };
}

// Both open: the viewer's own choice, else whichever started last.
export function nextStage(input: { workspaceOpen: boolean; shareActive: boolean; latest: StageChoice | null; choice: StageChoice | null }): Stage {
  if (input.workspaceOpen && input.shareActive) return input.choice ?? input.latest ?? "workspace";
  if (input.workspaceOpen) return "workspace";
  return input.shareActive ? "share" : "grid";
}

// Uploads

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function classifyUpload(name: string, mime = ""): UploadKind | null {
  const ext = extensionOf(name);
  const type = mime.toLowerCase();
  if (ext === "pdf" || type === "application/pdf") return "pdf";
  if ((IMAGE_EXTENSIONS as readonly string[]).includes(ext) || (IMAGE_TYPES as readonly string[]).includes(type)) return "image";
  if ((OFFICE_EXTENSIONS as readonly string[]).includes(ext)) return "office";
  return null;
}

export function isOfficeExtension(ext: string): ext is OfficeExtension {
  return (OFFICE_EXTENSIONS as readonly string[]).includes(ext);
}

function startsWith(bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + prefix.length) return false;
  return prefix.every((byte, index) => bytes[offset + index] === byte);
}

export function sniffImage(bytes: Uint8Array): PageImageType | null {
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  return null;
}

// OOXML and ODF are zip files, .doc/.ppt OLE compound files, .rtf starts with {\rtf.
export function sniffOffice(bytes: Uint8Array, ext: string): boolean {
  if (ext === "rtf") return startsWith(bytes, [0x7b, 0x5c, 0x72, 0x74, 0x66]);
  if (ext === "doc" || ext === "ppt") return startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  if (ext === "docx" || ext === "pptx" || ext === "odt" || ext === "odp") return startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]);
  return false;
}

// 1..max pages of integer [width, height], each side 1..MAX_PAGE_SIDE; `count`, when given, must match.
export function validatePageSizes(value: unknown, count?: number, max = MAX_DOC_PAGES): Array<[number, number]> | null {
  if (!Array.isArray(value) || !value.length || value.length > max) return null;
  if (count !== undefined && value.length !== count) return null;
  const pages: Array<[number, number]> = [];
  for (const item of value) {
    if (!Array.isArray(item) || item.length !== 2) return null;
    const [width, height] = item;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_PAGE_SIDE || height > MAX_PAGE_SIDE) return null;
    pages.push([width, height]);
  }
  return pages;
}

// Scales (width, height) down so the long side is at most `max`; never up. Integer sides, at least 1.
export function fitLongSide(width: number, height: number, max = PAGE_LONG_SIDE): { width: number; height: number; scale: number } {
  const long = Math.max(width, height);
  const scale = long > max ? max / long : 1;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale };
}

// A display name: control characters dropped, whitespace collapsed, at most MAX_DOC_NAME characters.
export function cleanDocName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return null;
  const chars = Array.from(clean);
  return chars.length > MAX_DOC_NAME ? chars.slice(0, MAX_DOC_NAME).join("").trimEnd() : clean;
}

export function pageKey(roomId: string, docId: string, page: number): string {
  return `rooms/${roomId}/docs/${docId}/${page}`;
}

export function roomFilesPrefix(roomId: string): string {
  return `rooms/${roomId}/`;
}
