import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RoomState, WorkspaceView } from "@/lib/confa-types";
import {
  acceptsBoard, acceptsDoc, acceptsShare, applyWorkspacePatch, boardContextFromState, boardSurface, canAnnotateBoard, canModerateBoard, classifyUpload,
  cleanDocName, clampPage, docContextFromState, docSurface, docTokenExp, fitLongSide, MAX_BOARD_PAGES, MAX_DOC_PAGES, mergeWorkspace, nextStage, parseSurface,
  selectBoardSnapshot, selectDocSnapshot, sniffImage, sniffOffice, surfaceKind, toWorkspaceView, validatePageSizes, workspaceLayout, workspaceUpdate,
  type DocumentRow, type WorkspaceRow,
} from "./workspace.ts";

const WS = "11111111-1111-4111-8111-111111111111";
const DOC = "22222222-2222-4222-8222-222222222222";

function row(over: Partial<WorkspaceRow> = {}): WorkspaceRow {
  return { room_id: "room", id: WS, open: 1, board_page: 0, board_pages: 3, board_collapsed: 0, doc_collapsed: 0, doc_id: null, all_draw: 0, version: 4, created_at: 1, updated_at: 1, ...over };
}

function doc(over: Partial<DocumentRow> = {}): DocumentRow {
  return { id: DOC, room_id: "room", name: "Урок 1.pdf", kind: "pdf", page_count: 3, pages: JSON.stringify([[1600, 900], [1600, 900], [900, 1600]]), page: 1, status: "ready", bytes: 10, created_at: 1, ...over };
}

function view(over: Partial<WorkspaceView> = {}): WorkspaceView {
  return { ...toWorkspaceView(row(), { ...doc(), token: "t" }), ...over };
}

function state(over: Partial<RoomState> = {}): RoomState {
  return {
    room: { id: "room", kind: "meeting", status: "open", activeShareId: null, activeShareOwner: null, annotationsEnabled: true },
    members: [
      { id: "h", name: "Учитель", role: "host", can_annotate: 1, raised_hand: 0, removed: 0, board_draw: 0 },
      { id: "a", name: "Аня", role: "speaker", can_annotate: 1, raised_hand: 0, removed: 0, board_draw: 1 },
      { id: "b", name: "Борис", role: "speaker", can_annotate: 1, raised_hand: 0, removed: 0, board_draw: 0 },
    ],
    messages: [], shareRequests: [], annotations: [], recording: null,
    workspace: view(),
    boardAnnotations: [], docAnnotations: [],
    ...over,
  };
}

describe("surfaces", () => {
  it("round-trips board and doc ids", () => {
    assert.deepEqual(parseSurface(boardSurface(WS, 4)), { kind: "board", workspaceId: WS, page: 4 });
    assert.deepEqual(parseSurface(docSurface(DOC, 0)), { kind: "doc", docId: DOC, page: 0 });
    assert.ok(boardSurface(WS, MAX_BOARD_PAGES - 1).length <= 64);
    assert.ok(docSurface(DOC, MAX_DOC_PAGES - 1).length <= 64);
  });

  it("rejects malformed ids, pages past the limits and non-canonical numbers", () => {
    for (const bad of [null, 5, "", "b:", `x:${WS}:1`, `b:${WS}`, `b:${WS}:-1`, `b:${WS}:01`, `b:${WS}:1.5`, `b:${"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".toUpperCase()}:1`, `b:not-a-uuid-not-a-uuid-not-a-uuid-xxxx:1`, `b:${WS}:${MAX_BOARD_PAGES}`, `d:${DOC}:${MAX_DOC_PAGES}`, ` b:${WS}:1`]) {
      assert.equal(parseSurface(bad), null, String(bad));
    }
    assert.ok(parseSurface(`d:${DOC}:${MAX_DOC_PAGES - 1}`));
  });

  it("routes by prefix", () => {
    assert.equal(surfaceKind(boardSurface(WS, 9)), "board");
    assert.equal(surfaceKind(docSurface(DOC, 9)), "doc");
    assert.equal(surfaceKind("3e5c2f8a-0000-4000-8000-000000000000"), "share");
    assert.equal(acceptsBoard("b:anything"), true);
    assert.equal(acceptsDoc("b:anything"), false);
    assert.equal(acceptsShare("d:x"), false);
    assert.equal(acceptsShare("plain-share"), true);
  });
});

describe("board permissions", () => {
  it("teacher always, students when called or when everyone may draw", () => {
    const on = { allDraw: true }, off = { allDraw: false };
    assert.equal(canAnnotateBoard({ role: "host" }, off), true);
    assert.equal(canAnnotateBoard({ role: "speaker", board_draw: 0 }, off), false);
    assert.equal(canAnnotateBoard({ role: "speaker", board_draw: 1 }, off), true);
    assert.equal(canAnnotateBoard({ role: "viewer", board_draw: true }, off), true);
    assert.equal(canAnnotateBoard({ role: "viewer" }, on), true);
    assert.equal(canAnnotateBoard(null, on), false);
    assert.equal(canAnnotateBoard({ role: "host" }, null), false);
    assert.equal(canModerateBoard({ role: "host" }), true);
    assert.equal(canModerateBoard({ role: "speaker" }), false);
  });

  it("sync contexts name the current surfaces and apply the board rule", () => {
    const s = state();
    const board = boardContextFromState(s, "a");
    assert.equal(board.shareId, boardSurface(WS, 0));
    assert.equal(board.selfId, "a");
    assert.equal(board.canAnnotate("a"), true);
    assert.equal(board.canAnnotate("b"), false);
    assert.equal(board.canAnnotate("h"), true);
    assert.equal(board.canModerate("h"), true);
    assert.equal(board.canModerate("a"), false);
    assert.equal(board.nameOf("b"), "Борис");
    assert.equal(docContextFromState(s, "a").shareId, docSurface(DOC, 1));
  });

  it("a closed workspace or a missing doc has no surface", () => {
    const closed = state({ workspace: view({ open: false }) });
    assert.equal(boardContextFromState(closed, "a").shareId, null);
    assert.equal(docContextFromState(closed, "a").shareId, null);
    assert.equal(docContextFromState(state({ workspace: view({ doc: null }) }), "a").shareId, null);
    assert.equal(boardContextFromState(null, "a").shareId, null);
    assert.equal(boardContextFromState(state({ workspace: null }), "a").canAnnotate("h"), false);
  });

  it("snapshots pick the server's surface ids and rows", () => {
    const rows = [{ id: "x", author_id: "h", author_name: "", kind: "pen" as const, payload: "{}", created_at: 0, seq: 1 }];
    assert.deepEqual(selectBoardSnapshot(state({ boardAnnotations: rows })), { shareId: boardSurface(WS, 0), rows });
    assert.deepEqual(selectDocSnapshot(state({ docAnnotations: rows })), { shareId: docSurface(DOC, 1), rows });
    assert.deepEqual(selectBoardSnapshot(state({ workspace: null, boardAnnotations: undefined })), { shareId: null, rows: [] });
  });
});

describe("workspaceUpdate", () => {
  const ready = { id: DOC, page_count: 3, status: "ready" as const };

  it("opens, closes, toggles drawing and collapses parts", () => {
    assert.deepEqual(workspaceUpdate(row({ open: 0 }), { action: "open" }, null), { set: { open: 1 } });
    assert.deepEqual(workspaceUpdate(row(), { action: "close" }, null), { set: { open: 0 } });
    assert.deepEqual(workspaceUpdate(row(), { action: "allDraw", enabled: true }, null), { set: { all_draw: 1 } });
    assert.deepEqual(workspaceUpdate(row(), { action: "collapse", part: "board", collapsed: true }, null), { set: { board_collapsed: 1 } });
    assert.deepEqual(workspaceUpdate(row(), { action: "collapse", part: "doc", collapsed: false }, null), { set: { doc_collapsed: 0 } });
    assert.ok("error" in workspaceUpdate(row(), { action: "collapse", part: "chat", collapsed: true }, null));
    assert.ok("error" in workspaceUpdate(row(), { action: "allDraw", enabled: "yes" }, null));
    assert.ok("error" in workspaceUpdate(row(), { action: "nope" }, null));
  });

  it("flips and adds sheets within the limit", () => {
    assert.deepEqual(workspaceUpdate(row(), { action: "boardPage", page: 2 }, null), { set: { board_page: 2 } });
    for (const page of [3, -1, 1.5, "1"]) assert.ok("error" in workspaceUpdate(row(), { action: "boardPage", page }, null), String(page));
    assert.deepEqual(workspaceUpdate(row(), { action: "addBoardPage" }, null), { set: { board_pages: 4, board_page: 3 } });
    const full = workspaceUpdate(row({ board_pages: MAX_BOARD_PAGES }), { action: "addBoardPage" }, null);
    assert.ok("error" in full && full.status === 409);
  });

  it("selects only ready documents and expands the material", () => {
    assert.deepEqual(workspaceUpdate(row({ doc_collapsed: 1 }), { action: "docSelect", docId: DOC }, ready), { set: { doc_id: DOC, doc_collapsed: 0 } });
    assert.ok("error" in workspaceUpdate(row(), { action: "docSelect", docId: DOC }, { ...ready, status: "uploading" }));
    assert.ok("error" in workspaceUpdate(row(), { action: "docSelect", docId: "other" }, ready));
    assert.ok("error" in workspaceUpdate(row(), { action: "docSelect", docId: DOC }, null));
  });

  it("pages the current document only", () => {
    assert.deepEqual(workspaceUpdate(row({ doc_id: DOC }), { action: "docPage", page: 2 }, ready), { set: {}, docPage: { docId: DOC, page: 2 } });
    assert.ok("error" in workspaceUpdate(row({ doc_id: DOC }), { action: "docPage", page: 3 }, ready));
    assert.ok("error" in workspaceUpdate(row({ doc_id: null }), { action: "docPage", page: 0 }, ready));
  });

  it("closing or deleting the current document clears it", () => {
    assert.deepEqual(workspaceUpdate(row({ doc_id: DOC }), { action: "docClose" }, null), { set: { doc_id: null } });
    assert.deepEqual(workspaceUpdate(row({ doc_id: DOC }), { action: "docDelete", docId: DOC }, ready), { set: { doc_id: null } });
    assert.deepEqual(workspaceUpdate(row({ doc_id: null }), { action: "docDelete", docId: DOC }, ready), { set: {} });
    assert.ok("error" in workspaceUpdate(row(), { action: "docDelete", docId: DOC }, { ...ready, status: "deleted" }));
  });
});

describe("workspace view", () => {
  it("clamps pages and builds surfaces", () => {
    const v = toWorkspaceView(row({ board_page: 9, board_pages: 2 }), { ...doc({ page: 7 }), token: "tok" }, [{ id: DOC, name: "x", kind: "pdf", pageCount: 3, createdAt: 1 }]);
    assert.equal(v.boardPage, 1);
    assert.equal(v.boardSurface, boardSurface(WS, 1));
    assert.equal(v.doc?.page, 2);
    assert.equal(v.doc?.surface, docSurface(DOC, 2));
    assert.deepEqual(v.doc?.pages[2], [900, 1600]);
    assert.equal(v.doc?.token, "tok");
    assert.equal(v.documents?.length, 1);
    assert.equal("documents" in toWorkspaceView(row(), null), false);
  });

  it("drops a document that is not ready or has broken page sizes", () => {
    assert.equal(toWorkspaceView(row(), { ...doc({ status: "uploading" }), token: "t" }).doc, null);
    assert.equal(toWorkspaceView(row(), { ...doc({ pages: "[[1,2]]" }), token: "t" }).doc, null);
    assert.equal(toWorkspaceView(row(), { ...doc({ pages: "not json" }), token: "t" }).doc, null);
  });

  it("clampPage keeps pages inside 0..count-1", () => {
    assert.equal(clampPage(5, 3), 2);
    assert.equal(clampPage(-2, 3), 0);
    assert.equal(clampPage(1, 0), 0);
    assert.equal(clampPage(Number.NaN, 4), 0);
  });

  it("doc tokens expire on a fixed window", () => {
    const window = 6 * 3600;
    assert.equal(docTokenExp(window * 10 + 5), window * 12);
    assert.equal(docTokenExp(window * 11 - 1), window * 12);
    assert.equal(docTokenExp(window * 11), window * 13);
  });
});

describe("host overlay", () => {
  it("applies a local patch until the server reports its version", () => {
    const server = view();
    const pending = { patch: { boardPage: 2, docPage: 0, docCollapsed: true }, version: 5 };
    const merged = mergeWorkspace(server, pending);
    assert.equal(merged?.boardPage, 2);
    assert.equal(merged?.boardSurface, boardSurface(WS, 2));
    assert.equal(merged?.doc?.surface, docSurface(DOC, 0));
    assert.equal(merged?.docCollapsed, true);
    assert.equal(mergeWorkspace({ ...server, version: 5 }, pending)?.boardPage, 0);
    assert.equal(mergeWorkspace(server, { patch: { boardPage: 1 }, version: null })?.boardPage, 1);
    assert.equal(mergeWorkspace(server, null), server);
    assert.equal(mergeWorkspace(null, pending), null);
  });

  it("a new sheet patch moves to it", () => {
    const v = applyWorkspacePatch(view(), { boardPages: 4, boardPage: 3 });
    assert.equal(v.boardPages, 4);
    assert.equal(v.boardPage, 3);
  });
});

describe("layout and stage", () => {
  const base = { width: 1600, height: 800, boardCollapsed: false, docCollapsed: false, hasDoc: true, isHost: false };

  it("side by side on wide areas, stacked otherwise", () => {
    assert.equal(workspaceLayout(base).orientation, "row");
    assert.equal(workspaceLayout({ ...base, width: 700, height: 900 }).orientation, "column");
    assert.equal(workspaceLayout({ ...base, width: 0, height: 0 }).orientation, "row");
  });

  it("collapsed parts become rails; both collapsed shows the camera grid", () => {
    assert.deepEqual(workspaceLayout({ ...base, boardCollapsed: true }), { orientation: "row", board: "rail", doc: "pane", grid: false });
    assert.deepEqual(workspaceLayout({ ...base, boardCollapsed: true, docCollapsed: true }), { orientation: "row", board: "rail", doc: "rail", grid: true });
  });

  it("students do not see an empty material; the teacher does", () => {
    assert.equal(workspaceLayout({ ...base, hasDoc: false }).doc, "hidden");
    assert.equal(workspaceLayout({ ...base, hasDoc: false, isHost: true }).doc, "pane");
    assert.equal(workspaceLayout({ ...base, hasDoc: false, boardCollapsed: true }).grid, true);
  });

  it("stage: the viewer's choice, else the latest, when both are on", () => {
    assert.equal(nextStage({ workspaceOpen: true, shareActive: false, latest: "share", choice: "share" }), "workspace");
    assert.equal(nextStage({ workspaceOpen: false, shareActive: true, latest: null, choice: null }), "share");
    assert.equal(nextStage({ workspaceOpen: false, shareActive: false, latest: null, choice: null }), "grid");
    assert.equal(nextStage({ workspaceOpen: true, shareActive: true, latest: "share", choice: null }), "share");
    assert.equal(nextStage({ workspaceOpen: true, shareActive: true, latest: "share", choice: "workspace" }), "workspace");
    assert.equal(nextStage({ workspaceOpen: true, shareActive: true, latest: null, choice: null }), "workspace");
  });
});

describe("uploads", () => {
  it("classifies by extension or type", () => {
    assert.equal(classifyUpload("Урок.PDF"), "pdf");
    assert.equal(classifyUpload("scan", "application/pdf"), "pdf");
    assert.equal(classifyUpload("photo.jpeg"), "image");
    assert.equal(classifyUpload("x", "image/webp"), "image");
    assert.equal(classifyUpload("slides.pptx"), "office");
    assert.equal(classifyUpload("essay.doc"), "office");
    assert.equal(classifyUpload("notes.rtf"), "office");
    assert.equal(classifyUpload("table.xlsx"), null);
    assert.equal(classifyUpload("archive.zip", "application/zip"), null);
    assert.equal(classifyUpload("noext"), null);
  });

  it("sniffs page images", () => {
    assert.equal(sniffImage(new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50])), "image/webp");
    assert.equal(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
    assert.equal(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), "image/png");
    assert.equal(sniffImage(new Uint8Array([0x3c, 0x73, 0x76, 0x67])), null);
    assert.equal(sniffImage(new Uint8Array([0x52, 0x49, 0x46, 0x46])), null);
  });

  it("sniffs office files by their container", () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0]);
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const rtf = new TextEncoder().encode("{\\rtf1\\ansi");
    assert.equal(sniffOffice(zip, "pptx"), true);
    assert.equal(sniffOffice(zip, "odt"), true);
    assert.equal(sniffOffice(ole, "ppt"), true);
    assert.equal(sniffOffice(ole, "docx"), false);
    assert.equal(sniffOffice(zip, "doc"), false);
    assert.equal(sniffOffice(rtf, "rtf"), true);
    assert.equal(sniffOffice(zip, "exe"), false);
  });

  it("validates page sizes", () => {
    assert.deepEqual(validatePageSizes([[1600, 900]]), [[1600, 900]]);
    assert.equal(validatePageSizes([]), null);
    assert.equal(validatePageSizes([[1600, 900]], 2), null);
    assert.equal(validatePageSizes([[0, 900]]), null);
    assert.equal(validatePageSizes([[1.5, 900]]), null);
    assert.equal(validatePageSizes([[20_000, 900]]), null);
    assert.equal(validatePageSizes([[1, 2, 3]]), null);
    assert.equal(validatePageSizes(Array.from({ length: MAX_DOC_PAGES + 1 }, () => [1, 1])), null);
    assert.equal(validatePageSizes("[[1,1]]"), null);
  });

  it("fits the long side without upscaling", () => {
    assert.deepEqual(fitLongSide(4000, 3000, 2000), { width: 2000, height: 1500, scale: 0.5 });
    assert.deepEqual(fitLongSide(800, 600, 2000), { width: 800, height: 600, scale: 1 });
    assert.deepEqual(fitLongSide(3000, 4000, 2000), { width: 1500, height: 2000, scale: 0.5 });
  });

  it("cleans document names", () => {
    assert.equal(cleanDocName("  Урок\n 5\t.pdf "), "Урок 5 .pdf");
    assert.equal(cleanDocName("\u0000\u0007"), null);
    assert.equal(cleanDocName(5), null);
    assert.equal(Array.from(cleanDocName("я".repeat(300)) ?? "").length, 120);
  });
});
