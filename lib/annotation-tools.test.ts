import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AnnotationKind, UiTool } from "@/lib/confa-types";
import {
  CHIP_GAP, CHIP_MAX_CHARS, COMPACT_AREA_WIDTH, DEFAULT_PREFS, DRAW_TOOLS, LASER_COLOR, LINE_VARIANTS, MARKER_OPACITY, PALETTE, PREFS_KEY, SHAPE_VARIANTS,
  TOOL_META, WIDTH_MAX, WIDTH_MIN, chipFontPx, chipName, defaultToolFor, hotkeyFor, isCreatingTool, markAnchor, mergePrefs, normalizePrefs, parsePrefs,
  placeChip, resolveEscape, samePrefs, serializePrefs, toolbarLayoutFor, toolPrefsPatch, toolShortcut, toolTitle, variantGroup, widthGroup, type AnnotationPrefs,
  type HotkeyEvent,
} from "./annotation-tools.ts";

const KINDS: AnnotationKind[] = ["pen", "line", "arrow", "dashed", "marker", "rect", "circle", "triangle", "hexagon", "text"];
const UI_TOOLS: UiTool[] = [...KINDS, "eraser", "move", "laser", "view"];

const key = (over: Partial<HotkeyEvent>): HotkeyEvent => ({ code: "", key: "", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, repeat: false, isComposing: false, ...over });

describe("constants", () => {
  it("keeps the nine palette colours, lowercase, with Russian labels; laser red is separate", () => {
    assert.deepEqual(PALETTE.map((c) => c.value), ["#6de7d4", "#ffcc75", "#ff7794", "#ffffff", "#000000", "#b9a7ff", "#d92d3a", "#2563eb", "#15803d"]);
    for (const c of PALETTE) assert.match(c.value, /^#[0-9a-f]{6}$/);
    assert.equal(PALETTE[0].label, "Мятный");
    assert.equal(LASER_COLOR, "#ff3b5c");
    assert.ok(!PALETTE.some((c) => c.value === LASER_COLOR));
    assert.equal(MARKER_OPACITY, 0.38);
    assert.equal(PREFS_KEY, "confa:annotation-prefs:v1");
  });

  it("describes every UI tool with a label, an icon and a group; hotkey codes are unique", () => {
    assert.deepEqual(Object.keys(TOOL_META).sort(), [...UI_TOOLS].sort());
    const codes = UI_TOOLS.map((t) => TOOL_META[t].code).filter(Boolean);
    assert.equal(new Set(codes).size, codes.length);
    for (const tool of UI_TOOLS) {
      const meta = TOOL_META[tool];
      assert.ok(meta.label.length > 0 && /[а-яё]/i.test(meta.label), tool);
      assert.match(meta.icon, /^[A-Z][A-Za-z]+$/);
    }
    assert.equal(TOOL_META.view.group, "mode");
    assert.equal(TOOL_META.laser.group, "mode");
    assert.equal(TOOL_META.dashed.dashed, true);
    assert.equal(TOOL_META.circle.label, "Эллипс");
  });

  it("lists every drawing tool once in the compact grid order", () => {
    assert.equal(DRAW_TOOLS.length, 12);
    assert.deepEqual([...DRAW_TOOLS].sort(), UI_TOOLS.filter((t) => t !== "laser" && t !== "view").sort());
    assert.deepEqual(DRAW_TOOLS.slice(0, 3), ["pen", "marker", "text"]);
    assert.deepEqual(DRAW_TOOLS.slice(9), ["hexagon", "move", "eraser"]);
  });
});

describe("tool helpers", () => {
  it("isCreatingTool: stored kinds only", () => {
    for (const kind of KINDS) assert.equal(isCreatingTool(kind), true, kind);
    for (const tool of ["eraser", "move", "laser", "view"] as UiTool[]) assert.equal(isCreatingTool(tool), false, tool);
  });

  it("widthGroup and variantGroup", () => {
    assert.equal(widthGroup("pen"), "pen");
    assert.equal(widthGroup("marker"), "marker");
    for (const tool of [...LINE_VARIANTS, ...SHAPE_VARIANTS]) assert.equal(widthGroup(tool), "shape", tool);
    for (const tool of ["text", "laser", "view", "move", "eraser"] as UiTool[]) assert.equal(widthGroup(tool), null, tool);
    for (const tool of LINE_VARIANTS) assert.equal(variantGroup(tool), "line");
    for (const tool of SHAPE_VARIANTS) assert.equal(variantGroup(tool), "shape");
    for (const tool of ["pen", "marker", "text", "laser", "view", "move", "eraser"] as UiTool[]) assert.equal(variantGroup(tool), null, tool);
  });

  it("titles and aria-keyshortcuts", () => {
    assert.equal(toolTitle("pen"), "Карандаш (P)");
    assert.equal(toolTitle("view"), "Просмотр (Esc)");
    assert.equal(toolTitle("circle"), "Эллипс");
    assert.equal(toolTitle("rect"), "Прямоугольник (R)");
    assert.equal(toolTitle("hexagon"), "Шестиугольник");
    assert.equal(toolShortcut("pen"), "P");
    assert.equal(toolShortcut("laser"), "L");
    assert.equal(toolShortcut("view"), "Escape");
    assert.equal(toolShortcut("circle"), undefined);
  });

  it("toolPrefsPatch remembers creating tools and their variant", () => {
    assert.deepEqual(toolPrefsPatch("pen"), { lastDrawTool: "pen" });
    assert.deepEqual(toolPrefsPatch("text"), { lastDrawTool: "text" });
    assert.deepEqual(toolPrefsPatch("arrow"), { lastDrawTool: "arrow", lineVariant: "arrow" });
    assert.deepEqual(toolPrefsPatch("dashed"), { lastDrawTool: "dashed", lineVariant: "dashed" });
    assert.deepEqual(toolPrefsPatch("circle"), { lastDrawTool: "circle", shapeVariant: "circle" });
    for (const tool of ["laser", "view", "move", "eraser"] as UiTool[]) assert.deepEqual(toolPrefsPatch(tool), {}, tool);
  });

  it("defaultToolFor: armed fine pointers get lastDrawTool, everyone else Просмотр", () => {
    for (const armedByDefault of [true, false]) {
      for (const coarse of [true, false]) {
        for (const lastDrawTool of ["arrow", "eraser"] as UiTool[]) {
          const expected = !armedByDefault || coarse ? "view" : lastDrawTool === "arrow" ? "arrow" : "pen";
          assert.equal(defaultToolFor({ armedByDefault, coarse, lastDrawTool }), expected, `${armedByDefault} ${coarse} ${lastDrawTool}`);
        }
      }
    }
    assert.equal(defaultToolFor({ armedByDefault: true, coarse: false, lastDrawTool: "laser" }), "pen");
    assert.equal(defaultToolFor({ armedByDefault: true, coarse: false, lastDrawTool: "view" }), "pen");
    assert.equal(defaultToolFor({ armedByDefault: true, coarse: false, lastDrawTool: "text" }), "text");
  });
});

describe("prefs", () => {
  it("defaults", () => {
    assert.deepEqual(DEFAULT_PREFS, {
      lastDrawTool: "pen", lineVariant: "arrow", shapeVariant: "rect", laserStyle: "laser", color: "#6de7d4",
      widths: { pen: 4, marker: 16, shape: 4 }, textSize: "m", showAuthors: false, hotkeys: true, fingersDraw: false,
    });
    assert.ok(Object.isFrozen(DEFAULT_PREFS) && Object.isFrozen(DEFAULT_PREFS.widths));
  });

  it("falls back to defaults on missing or broken storage", () => {
    for (const raw of [null, undefined, "", "{", "null", "[]", "[1,2]", "\"pen\"", "42", "true", "{\"widths\":"]) assert.deepEqual(parsePrefs(raw), DEFAULT_PREFS, String(raw));
  });

  it("validates field by field and keeps the good ones", () => {
    const prefs = parsePrefs(JSON.stringify({ lastDrawTool: "hexagon", color: "#ff7794", widths: { marker: 20 }, showAuthors: true, extra: 1 }));
    assert.deepEqual(prefs, { ...DEFAULT_PREFS, lastDrawTool: "hexagon", color: "#ff7794", widths: { pen: 4, marker: 20, shape: 4 }, showAuthors: true });
    assert.ok(!("extra" in prefs));
  });

  it("clamps and rounds widths, rejects non-numbers", () => {
    const prefs = parsePrefs(JSON.stringify({ widths: { pen: 99, marker: 0, shape: 4.6 } }));
    assert.deepEqual(prefs.widths, { pen: WIDTH_MAX, marker: WIDTH_MIN, shape: 5 });
    assert.deepEqual(parsePrefs(JSON.stringify({ widths: { pen: "8", marker: null, shape: [3] } })).widths, DEFAULT_PREFS.widths);
    assert.deepEqual(parsePrefs(JSON.stringify({ widths: [1, 2, 3] })).widths, DEFAULT_PREFS.widths);
    assert.deepEqual(normalizePrefs({ widths: { pen: Infinity, marker: NaN, shape: -5 } }).widths, { pen: 4, marker: 16, shape: WIDTH_MIN });
  });

  it("rejects wrong types, unknown colours and non-creating lastDrawTool", () => {
    const prefs = parsePrefs(JSON.stringify({
      lastDrawTool: "eraser", lineVariant: "rect", shapeVariant: "arrow", laserStyle: "beam", color: "#123456", textSize: "xl",
      showAuthors: "yes", hotkeys: 0, fingersDraw: null,
    }));
    assert.deepEqual(prefs, DEFAULT_PREFS);
    assert.equal(parsePrefs(JSON.stringify({ lastDrawTool: "laser" })).lastDrawTool, "pen");
    assert.equal(parsePrefs(JSON.stringify({ lastDrawTool: "view" })).lastDrawTool, "pen");
    assert.equal(parsePrefs(JSON.stringify({ color: 0xffffff })).color, DEFAULT_PREFS.color);
  });

  it("accepts palette colours in any case and with spaces", () => {
    assert.equal(parsePrefs(JSON.stringify({ color: " #FFCC75 " })).color, "#ffcc75");
  });

  it("ignores a __proto__ key", () => {
    const prefs = parsePrefs("{\"__proto__\":{\"color\":\"#000000\",\"hotkeys\":false}}");
    assert.deepEqual(prefs, DEFAULT_PREFS);
    assert.equal(Object.getPrototypeOf(prefs), Object.prototype);
  });

  it("serializes only known keys and round-trips", () => {
    const prefs: AnnotationPrefs = { ...DEFAULT_PREFS, laserStyle: "ink", textSize: "l", hotkeys: false, fingersDraw: true, widths: { pen: 7, marker: 18, shape: 2 } };
    const raw = serializePrefs({ ...prefs, junk: "x" } as AnnotationPrefs);
    assert.ok(!raw.includes("junk"));
    assert.deepEqual(parsePrefs(raw), prefs);
    assert.deepEqual(Object.keys(JSON.parse(raw)), Object.keys(DEFAULT_PREFS));
  });

  it("mergePrefs merges partial widths and keeps the previous value for invalid patches", () => {
    const prev = mergePrefs(DEFAULT_PREFS, { color: "#000000", widths: { pen: 9 } });
    assert.deepEqual(prev.widths, { pen: 9, marker: 16, shape: 4 });
    assert.equal(prev.color, "#000000");
    const next = mergePrefs(prev, { color: "red", widths: { marker: 300, shape: Number.NaN }, textSize: "xl" as never, showAuthors: true });
    assert.deepEqual(next, { ...prev, widths: { pen: 9, marker: WIDTH_MAX, shape: 4 }, showAuthors: true });
    assert.equal(DEFAULT_PREFS.color, "#6de7d4", "never mutates the defaults");
  });

  it("samePrefs compares every field", () => {
    assert.equal(samePrefs(DEFAULT_PREFS, parsePrefs(null)), true);
    assert.equal(samePrefs(DEFAULT_PREFS, mergePrefs(DEFAULT_PREFS, { widths: { shape: 5 } })), false);
    assert.equal(samePrefs(DEFAULT_PREFS, mergePrefs(DEFAULT_PREFS, { fingersDraw: true })), false);
    assert.equal(samePrefs(DEFAULT_PREFS, mergePrefs(DEFAULT_PREFS, { lineVariant: "line" })), false);
  });
});

describe("hotkeyFor", () => {
  it("maps P M A R T V E L by code", () => {
    const expected: Record<string, UiTool> = { KeyP: "pen", KeyM: "marker", KeyA: "arrow", KeyR: "rect", KeyT: "text", KeyV: "move", KeyE: "eraser", KeyL: "laser" };
    for (const [code, tool] of Object.entries(expected)) assert.deepEqual(hotkeyFor(key({ code, key: code.slice(3).toLowerCase() })), { type: "tool", tool }, code);
  });

  it("works on the ЙЦУКЕН layout (code, not key)", () => {
    assert.deepEqual(hotkeyFor(key({ code: "KeyP", key: "з" })), { type: "tool", tool: "pen" });
    assert.deepEqual(hotkeyFor(key({ code: "KeyE", key: "у" })), { type: "tool", tool: "eraser" });
    assert.deepEqual(hotkeyFor(key({ code: "KeyZ", key: "я", ctrlKey: true })), { type: "undo" });
  });

  it("falls back to a Latin key when code is empty", () => {
    assert.deepEqual(hotkeyFor(key({ key: "p" })), { type: "tool", tool: "pen" });
    assert.equal(hotkeyFor(key({ key: "з" })), null);
  });

  it("ignores unmapped keys and tool keys with modifiers", () => {
    for (const code of ["KeyQ", "KeyC", "Digit1", "Space", "Enter", "KeyZ", "KeyY"]) assert.equal(hotkeyFor(key({ code })), null, code);
    assert.equal(hotkeyFor(key({ code: "KeyP", ctrlKey: true })), null);
    assert.equal(hotkeyFor(key({ code: "KeyP", metaKey: true })), null);
    assert.equal(hotkeyFor(key({ code: "KeyP", altKey: true })), null);
    assert.equal(hotkeyFor(key({ code: "KeyP", shiftKey: true })), null);
  });

  it("undo and redo", () => {
    assert.deepEqual(hotkeyFor(key({ code: "KeyZ", ctrlKey: true })), { type: "undo" });
    assert.deepEqual(hotkeyFor(key({ code: "KeyZ", metaKey: true })), { type: "undo" });
    assert.deepEqual(hotkeyFor(key({ code: "KeyZ", ctrlKey: true, shiftKey: true })), { type: "redo" });
    assert.deepEqual(hotkeyFor(key({ code: "KeyZ", metaKey: true, shiftKey: true })), { type: "redo" });
    assert.deepEqual(hotkeyFor(key({ code: "KeyY", ctrlKey: true })), { type: "redo" });
    assert.equal(hotkeyFor(key({ code: "KeyY", metaKey: true })), null, "Cmd+Y is browser history on macOS");
    assert.equal(hotkeyFor(key({ code: "KeyY", ctrlKey: true, shiftKey: true })), null);
    assert.equal(hotkeyFor(key({ code: "KeyZ", ctrlKey: true, altKey: true })), null, "AltGr = Ctrl+Alt");
    assert.equal(hotkeyFor(key({ code: "KeyP", ctrlKey: true, shiftKey: true })), null);
  });

  it("Escape", () => {
    assert.deepEqual(hotkeyFor(key({ code: "Escape", key: "Escape" })), { type: "escape" });
    assert.deepEqual(hotkeyFor(key({ key: "Escape" })), { type: "escape" });
    assert.deepEqual(hotkeyFor(key({ code: "Escape", key: "Escape", shiftKey: true })), { type: "escape" });
    assert.equal(hotkeyFor(key({ code: "Escape", key: "Escape", ctrlKey: true })), null);
  });

  it("ignores repeats and IME composition", () => {
    assert.equal(hotkeyFor(key({ code: "KeyP", repeat: true })), null);
    assert.equal(hotkeyFor(key({ code: "KeyZ", ctrlKey: true, repeat: true })), null);
    assert.equal(hotkeyFor(key({ code: "Escape", key: "Escape", repeat: true })), null);
    assert.equal(hotkeyFor(key({ code: "KeyP", isComposing: true })), null);
    assert.equal(hotkeyFor(key({ code: "KeyP", key: "Process" })), null);
    assert.deepEqual(hotkeyFor({ code: "KeyP", key: "p", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, repeat: false }), { type: "tool", tool: "pen" }, "isComposing is optional");
  });

  it("resolveEscape order: overlays, gesture, Просмотр, pass", () => {
    assert.equal(resolveEscape({ overlayOpen: true, gestureActive: true, tool: "pen" }), "pass");
    assert.equal(resolveEscape({ overlayOpen: false, gestureActive: true, tool: "pen" }), "cancel-gesture");
    assert.equal(resolveEscape({ overlayOpen: false, gestureActive: false, tool: "laser" }), "view");
    assert.equal(resolveEscape({ overlayOpen: false, gestureActive: false, tool: "view" }), "pass");
  });
});

describe("author chips", () => {
  it("markAnchor for each kind", () => {
    assert.deepEqual(markAnchor("text", { color: "#fff", point: [0.3, 0.4], text: "x" }), [0.3, 0.4]);
    assert.deepEqual(markAnchor("pen", { color: "#fff", points: [[0.5, 0.5], [0.1, 0.9], [0.7, 0.2]] }), [0.5, 0.5]);
    assert.deepEqual(markAnchor("marker", { color: "#fff", points: [[0.2, 0.3]] }), [0.2, 0.3]);
    for (const kind of LINE_VARIANTS) assert.deepEqual(markAnchor(kind, { color: "#fff", points: [[0.8, 0.8], [0.1, 0.1]] }), [0.8, 0.8], kind);
    for (const kind of SHAPE_VARIANTS) assert.deepEqual(markAnchor(kind, { color: "#fff", points: [[0.8, 0.2], [0.1, 0.6]] }), [0.1, 0.2], kind);
  });

  it("markAnchor without usable coordinates", () => {
    assert.equal(markAnchor("pen", { color: "#fff" }), null);
    assert.equal(markAnchor("pen", { color: "#fff", points: [] }), null);
    assert.equal(markAnchor("text", { color: "#fff", text: "x" }), null);
    assert.equal(markAnchor("rect", { color: "#fff", points: [[Number.NaN, 0.1]] }), null);
    assert.deepEqual(markAnchor("rect", { color: "#fff", points: [[Number.NaN, 0.1], [0.4, 0.5], [0.6, 0.3]] }), [0.4, 0.3]);
    assert.deepEqual(markAnchor("line", { color: "#fff", point: [0.2, 0.2] }), [0.2, 0.2], "legacy text row stored with another kind");
  });

  const box = { width: 400, height: 300 };
  const chip = { width: 80, height: 20 };

  it("placeChip below-right by default", () => {
    assert.deepEqual(placeChip([100, 100], box, chip), [100 + CHIP_GAP, 100 + CHIP_GAP]);
    assert.deepEqual(placeChip([100, 100], box, chip, { gap: 4 }), [104, 104]);
  });

  it("placeChip flips at the right and bottom edges", () => {
    assert.deepEqual(placeChip([350, 100], box, chip), [350 - CHIP_GAP - 80, 110]);
    assert.deepEqual(placeChip([100, 290], box, chip), [110, 290 - CHIP_GAP - 20]);
    assert.deepEqual(placeChip([395, 295], box, chip), [395 - CHIP_GAP - 80, 295 - CHIP_GAP - 20]);
  });

  it("placeChip above for saved marks, flipping below at the top", () => {
    assert.deepEqual(placeChip([100, 100], box, chip, { prefer: "above" }), [110, 100 - CHIP_GAP - 20]);
    assert.deepEqual(placeChip([100, 5], box, chip, { prefer: "above" }), [110, 5 + CHIP_GAP]);
  });

  it("placeChip always stays inside the box", () => {
    for (const anchor of [[0, 0], [400, 300], [-50, 500], [200, 150], [5, 295]] as [number, number][]) {
      for (const prefer of ["below", "above"] as const) {
        const [x, y] = placeChip(anchor, box, chip, { prefer });
        assert.ok(x >= 0 && x + chip.width <= box.width && y >= 0 && y + chip.height <= box.height, `${anchor} ${prefer} -> ${x},${y}`);
      }
    }
    assert.deepEqual(placeChip([10, 10], { width: 50, height: 10 }, chip), [0, 0], "chip larger than the box");
    assert.deepEqual(placeChip([Number.NaN, Number.POSITIVE_INFINITY], box, chip), [CHIP_GAP, CHIP_GAP]);
  });

  it("chipFontPx and chipName", () => {
    assert.equal(chipFontPx(720), 12);
    assert.equal(chipFontPx(400), 10);
    assert.equal(chipFontPx(200), 9);
    assert.equal(chipFontPx(0), 9);
    assert.equal(chipName("  Аня  "), "Аня");
    assert.equal(chipName("Анна\n  Петрова"), "Анна Петрова");
    assert.equal(chipName(""), "Участник");
    assert.equal(chipName(null), "Участник");
    assert.equal(chipName("   ", "Гость"), "Гость");
    const long = "Константин Константинопольский";
    const cut = chipName(long);
    assert.ok(cut.endsWith("…"));
    assert.equal(Array.from(cut).length, CHIP_MAX_CHARS + 1);
    assert.equal(chipName("😀".repeat(30)), `${"😀".repeat(CHIP_MAX_CHARS)}…`, "never splits a surrogate pair");
    assert.equal(chipName("Иван Иванович Ивановски Петров"), "Иван Иванович Ивановски…", "no space before the ellipsis");
  });
});

describe("toolbarLayoutFor", () => {
  const layout = (expanded: boolean, coarse: boolean, short: boolean, areaWidth: number) => toolbarLayoutFor({ expanded, coarse, short, areaWidth });

  it("desktop: row normally, overlay when expanded", () => {
    assert.deepEqual(layout(false, false, false, 1200), { placement: "row", compact: false, orientation: "horizontal" });
    assert.deepEqual(layout(true, false, false, 1200), { placement: "overlay", compact: false, orientation: "horizontal" });
  });

  it("narrow or coarse: compact row, also when expanded", () => {
    for (const expanded of [true, false]) {
      assert.deepEqual(layout(expanded, false, false, COMPACT_AREA_WIDTH - 1), { placement: "row", compact: true, orientation: "horizontal" });
      assert.deepEqual(layout(expanded, true, false, 1600), { placement: "row", compact: true, orientation: "horizontal" });
    }
    assert.equal(layout(true, false, false, COMPACT_AREA_WIDTH).placement, "overlay");
  });

  it("short viewport (phone landscape): compact vertical column", () => {
    for (const expanded of [true, false]) {
      for (const coarse of [true, false]) assert.deepEqual(layout(expanded, coarse, true, 844), { placement: "column", compact: true, orientation: "vertical" });
    }
  });

  it("an unmeasured area counts as wide", () => {
    assert.deepEqual(layout(false, false, false, 0), { placement: "row", compact: false, orientation: "horizontal" });
    assert.equal(layout(false, false, false, Number.NaN).compact, false);
  });

  it("returns stable frozen objects", () => {
    assert.equal(layout(true, false, false, 1200), layout(true, false, false, 1300));
    assert.equal(layout(false, true, false, 300), layout(true, false, false, 500));
    assert.ok(Object.isFrozen(layout(false, false, true, 0)));
  });
});
