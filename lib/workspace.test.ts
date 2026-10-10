import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RoomState, WorkspaceView } from "@/lib/confa-types";
import {
  acceptsShare, applyWorkspacePatch, boardRange, boardSurface, canAnnotateBoard, canModerateBoard, classifyUpload,
  cleanDocName, clampPage, docSurface, docTokenExp, fitLongSide, MAX_BOARD_BANDS, MAX_DOC_PAGES, mergeWorkspace, nextStage, parseSurface,
  sniffImage, sniffOffice, studentBandLimit, surfaceKind, toWorkspaceView, validatePageSizes, workspaceContext, workspaceLayout, workspaceUpdate,
  type DocumentRow, type WorkspaceRow,
} from "./workspace.ts";

const WS = "11111111-1111-4111-8111-111111111111";
const DOC = "22222222-2222-4222-8222-222222222222";

function row(over: Partial<WorkspaceRow> = {}): WorkspaceRow {
  return { room_id: "room", id: WS, open: 1, board_page: 0, board_pages: 3, board_pos: 0, board_collapsed: 0, doc_collapsed: 0, doc_id: null, all_draw: 0, version: 4, created_at: 1, updated_at: 1, ...over };
}

function doc(over: Partial<DocumentRow> = {}): DocumentRow {
  return { id: DOC, room_id: "room", name: "Урок 1.pdf", kind: "pdf", page_count: 3, pages: JSON.stringify([[1600, 900], [1600, 900], [900, 1600]]), page: 1, pos: 1.25, status: "ready", bytes: 10, created_at: 1, ...over };
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
    ...over,
  };
}

describe("surfaces", () => {
  it("round-trips board and doc ids", () => {
    assert.deepEqual(parseSurface(boardSurface(WS, 4)), { kind: "board", workspaceId: WS, page: 4 });
    assert.deepEqual(parseSurface(boardSurface(WS, MAX_BOARD_BANDS - 1)), { kind: "board", workspaceId: WS, page: 199 });
    assert.deepEqual(parseSurface(docSurface(DOC, 0)), { kind: "doc", docId: DOC, page: 0 });
    assert.ok(boardSurface(WS, MAX_BOARD_BANDS - 1).length <= 64);
    assert.ok(docSurface(DOC, MAX_DOC_PAGES - 1).length <= 64);
  });

  it("rejects malformed ids, pages past the limits and non-canonical numbers", () => {
    for (const bad of [null, 5, "", "b:", `x:${WS}:1`, `b:${WS}`, `b:${WS}:-1`, `b:${WS}:01`, `b:${WS}:1.5`, `b:${"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".toUpperCase()}:1`, `b:not-a-uuid-not-a-uuid-not-a-uuid-xxxx:1`, `b:${WS}:${MAX_BOARD_BANDS}`, `d:${DOC}:${MAX_DOC_PAGES}`, ` b:${WS}:1`]) {
      assert.equal(parseSurface(bad), null, String(bad));
    }
    assert.ok(parseSurface(`d:${DOC}:${MAX_DOC_PAGES - 1}`));
  });

  it("routes by prefix; a board's bands are one share_id range", () => {
    assert.equal(surfaceKind(boardSurface(WS, 9)), "board");
    assert.equal(surfaceKind(docSurface(DOC, 9)), "doc");
    assert.equal(surfaceKind("3e5c2f8a-0000-4000-8000-000000000000"), "share");
    assert.equal(acceptsShare("d:x"), false);
    assert.equal(acceptsShare("plain-share"), true);
    const range = boardRange(WS);
    for (const band of [0, 9, 10, 199]) assert.ok(boardSurface(WS, band) >= range.from && boardSurface(WS, band) < range.to, String(band));
    assert.ok(!(docSurface(WS, 0) >= range.from && docSurface(WS, 0) < range.to));
    assert.ok(!(boardSurface(DOC, 0) >= range.from && boardSurface(DOC, 0) < range.to));
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

  it("a surface's sync context carries its own id and the board rule", () => {
    const band = boardSurface(WS, 7);
    const context = workspaceContext(state(), "a", band);
    assert.equal(context.shareId, band);
    assert.equal(context.selfId, "a");
    assert.equal(context.canAnnotate("a"), true);
    assert.equal(context.canAnnotate("b"), false);
    assert.equal(context.canAnnotate("h"), true);
    assert.equal(context.canModerate("h"), true);
    assert.equal(context.canModerate("a"), false);
    assert.equal(context.nameOf("b"), "Борис");
  });

  it("a student reaches the bands in use, the first blank one and the teacher's window", () => {
    assert.equal(studentBandLimit(row({ board_pages: 3, board_pos: 0 })), 4, "the window at the top shows bands 0..4");
    assert.equal(studentBandLimit(row({ board_pages: 9, board_pos: 1.5 })), 9, "the first blank band below the marks");
    assert.equal(studentBandLimit(row({ board_pages: 3, board_pos: 20.7 })), 24, "the teacher scrolled on to clean paper");
    assert.equal(studentBandLimit(row({ board_pages: 200, board_pos: 199.5 })), MAX_BOARD_BANDS - 1);
    assert.equal(studentBandLimit(row({ board_pages: 1, board_pos: Number.NaN })), 4);
  });

  it("without a workspace nobody may draw", () => {
    assert.equal(workspaceContext(null, "a", "x").shareId, null);
    assert.equal(workspaceContext(state({ workspace: null }), "a", "x").canAnnotate("h"), false);
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

  it("stores the teacher's board position quietly", () => {
    assert.deepEqual(workspaceUpdate(row(), { action: "view", part: "board", pos: 12.34567 }, null), { set: { board_pos: 12.3457, board_page: 12 }, quiet: true });
    for (const pos of [-0.1, MAX_BOARD_BANDS, Number.NaN, "3"]) assert.ok("error" in workspaceUpdate(row(), { action: "view", part: "board", pos }, null), String(pos));
    assert.ok("error" in workspaceUpdate(row(), { action: "view", part: "chat", pos: 1 }, null));
  });

  it("stores the position in the current document only", () => {
    assert.deepEqual(workspaceUpdate(row({ doc_id: DOC }), { action: "view", part: "doc", pos: 1.5 }, ready), { set: {}, docPos: { docId: DOC, pos: 1.5 }, quiet: true });
    const end = workspaceUpdate(row({ doc_id: DOC }), { action: "view", part: "doc", pos: 3 }, ready);
    assert.ok("docPos" in end && end.docPos && end.docPos.pos < 3 && end.docPos.pos > 2.99, "the very end stays on the last page");
    assert.ok("error" in workspaceUpdate(row({ doc_id: DOC }), { action: "view", part: "doc", pos: 3.5 }, ready));
    assert.ok("error" in workspaceUpdate(row({ doc_id: null }), { action: "view", part: "doc", pos: 0 }, ready));
    assert.ok("error" in workspaceUpdate(row({ doc_id: DOC }), { action: "view", part: "doc", pos: 0 }, { ...ready, id: "other" }));
  });

  it("clearing the board resets its extent and position", () => {
    assert.deepEqual(workspaceUpdate(row({ board_pages: 40, board_pos: 31.5 }), { action: "boardClear" }, null), { set: { board_pos: 0, board_page: 0, board_pages: 1 }, clearBoard: true });
  });

  it("tabs opened before the scrolling workspace are told to reload", () => {
    for (const action of ["boardPage", "addBoardPage", "docPage"]) {
      const result = workspaceUpdate(row({ doc_id: DOC }), { action, page: 1 }, ready);
      assert.ok("error" in result && result.status === 409 && /перезагрузите/.test(result.error), action);
    }
  });

  it("selects only ready documents and expands the material", () => {
    assert.deepEqual(workspaceUpdate(row({ doc_collapsed: 1 }), { action: "docSelect", docId: DOC }, ready), { set: { doc_id: DOC, doc_collapsed: 0 } });
    assert.ok("error" in workspaceUpdate(row(), { action: "docSelect", docId: DOC }, { ...ready, status: "uploading" }));
    assert.ok("error" in workspaceUpdate(row(), { action: "docSelect", docId: "other" }, ready));
    assert.ok("error" in workspaceUpdate(row(), { action: "docSelect", docId: DOC }, null));
  });

  it("closing or deleting the current document clears it", () => {
    assert.deepEqual(workspaceUpdate(row({ doc_id: DOC }), { action: "docClose" }, null), { set: { doc_id: null } });
    assert.deepEqual(workspaceUpdate(row({ doc_id: DOC }), { action: "docDelete", docId: DOC }, ready), { set: { doc_id: null } });
    assert.deepEqual(workspaceUpdate(row({ doc_id: null }), { action: "docDelete", docId: DOC }, ready), { set: {} });
    assert.ok("error" in workspaceUpdate(row(), { action: "docDelete", docId: DOC }, { ...ready, status: "deleted" }));
  });
});

describe("workspace view", () => {
  it("reports positions, the bands in use and the material", () => {
    const v = toWorkspaceView(row({ board_pos: 5.5, board_pages: 9 }), { ...doc({ pos: 2.4 }), token: "tok" }, [{ id: DOC, name: "x", kind: "pdf", pageCount: 3, createdAt: 1 }]);
    assert.equal(v.boardPos, 5.5);
    assert.equal(v.boardPages, 9);
    assert.equal(v.doc?.pos, 2.4);
    assert.deepEqual(v.doc?.pages[2], [900, 1600]);
    assert.equal(v.doc?.token, "tok");
    assert.equal(v.documents?.length, 1);
    assert.equal("documents" in toWorkspaceView(row(), null), false);
  });

  it("clamps odd stored values", () => {
    const v = toWorkspaceView(row({ board_pos: 9999, board_pages: 9999 }), { ...doc({ pos: 7 }), token: "t" });
    assert.ok(v.boardPos < MAX_BOARD_BANDS);
    assert.equal(v.boardPages, MAX_BOARD_BANDS);
    assert.ok(v.doc && v.doc.pos < 3 && v.doc.pos > 2.99);
    assert.equal(toWorkspaceView(row({ board_pos: Number.NaN }), null).boardPos, 0);
  });

  it("keeps what tabs opened before the scrolling workspace read: the sheet and page under the teacher's position", () => {
    const v = toWorkspaceView(row({ board_pos: 1.7, board_pages: 3 }), { ...doc({ pos: 2.4 }), token: "t" });
    assert.equal(v.boardPage, 1);
    assert.equal(v.boardSurface, boardSurface(WS, 1));
    assert.equal(v.doc?.page, 2);
    assert.equal(v.doc?.surface, docSurface(DOC, 2));
    assert.equal(toWorkspaceView(row({ board_pos: 8.2, board_pages: 3 }), null).boardPage, 2, "beyond the bands in use: the last one");
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
    const pending = { patch: { docCollapsed: true, allDraw: true }, version: 5 };
    const merged = mergeWorkspace(server, pending);
    assert.equal(merged?.docCollapsed, true);
    assert.equal(merged?.allDraw, true);
    assert.equal(merged?.boardCollapsed, false);
    assert.equal(mergeWorkspace({ ...server, version: 5 }, pending)?.docCollapsed, false);
    assert.equal(mergeWorkspace(server, { patch: { open: false }, version: null })?.open, false);
    assert.equal(mergeWorkspace(server, null), server);
    assert.equal(mergeWorkspace(null, pending), null);
    assert.equal(applyWorkspacePatch(server, {}).open, true);
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
