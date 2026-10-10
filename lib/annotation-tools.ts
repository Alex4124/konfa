import type { Size } from "@/lib/annotation-geometry";
import type { AnnotationKind, AnnotationPayload, LaserStyle, Point, Tool, UiTool } from "@/lib/confa-types";

export const PREFS_KEY = "confa:annotation-prefs:v1";
export const LASER_COLOR = "#ff3b5c";
export const MARKER_OPACITY = 0.38;
export const WIDTH_MIN = 1;
export const WIDTH_MAX = 24;
export const COMPACT_AREA_WIDTH = 840; // the full toolbar is about 833 px wide
export const CHIP_GAP = 10;
export const CHIP_MAX_CHARS = 24;

export const PALETTE: ReadonlyArray<{ readonly value: string; readonly label: string }> = [
  { value: "#6de7d4", label: "Мятный" },
  { value: "#ffcc75", label: "Жёлтый" },
  { value: "#ff7794", label: "Розовый" },
  { value: "#ffffff", label: "Белый" },
  { value: "#000000", label: "Чёрный" },
  { value: "#b9a7ff", label: "Лавандовый" },
  // Dark colours for white material pages, where the light ones above are hard to read.
  { value: "#d92d3a", label: "Красный" },
  { value: "#2563eb", label: "Синий" },
  { value: "#15803d", label: "Зелёный" },
];

export type LineVariant = "line" | "arrow" | "dashed";
export type ShapeVariant = "rect" | "circle" | "triangle" | "hexagon";
export type TextSize = "s" | "m" | "l";
export type WidthGroup = "pen" | "marker" | "shape";
export type ToolGroup = "mode" | "draw" | "line" | "shape" | "edit";
// lucide-react export names; the toolbar maps them with an exhaustive Record<ToolIconName, LucideIcon>.
export type ToolIconName = "Eye" | "WandSparkles" | "Pen" | "Highlighter" | "Minus" | "ArrowUpRight" | "RectangleHorizontal" | "Circle" | "Triangle" | "Hexagon" | "Type" | "Grab" | "Eraser";
// code: KeyboardEvent.code; key: what the UI shows; dashed: draw the icon with a dash pattern.
export type ToolMeta = { readonly label: string; readonly icon: ToolIconName; readonly group: ToolGroup; readonly code?: string; readonly key?: string; readonly dashed?: boolean };

export const TOOL_META: Readonly<Record<UiTool, ToolMeta>> = {
  view: { label: "Просмотр", icon: "Eye", group: "mode", code: "Escape", key: "Esc" },
  laser: { label: "Указка", icon: "WandSparkles", group: "mode", code: "KeyL", key: "L" },
  pen: { label: "Карандаш", icon: "Pen", group: "draw", code: "KeyP", key: "P" },
  marker: { label: "Маркер", icon: "Highlighter", group: "draw", code: "KeyM", key: "M" },
  text: { label: "Текст", icon: "Type", group: "draw", code: "KeyT", key: "T" },
  line: { label: "Прямая линия", icon: "Minus", group: "line" },
  arrow: { label: "Стрелка", icon: "ArrowUpRight", group: "line", code: "KeyA", key: "A" },
  dashed: { label: "Пунктир", icon: "Minus", group: "line", dashed: true },
  rect: { label: "Прямоугольник", icon: "RectangleHorizontal", group: "shape", code: "KeyR", key: "R" },
  circle: { label: "Эллипс", icon: "Circle", group: "shape" },
  triangle: { label: "Треугольник", icon: "Triangle", group: "shape" },
  hexagon: { label: "Шестиугольник", icon: "Hexagon", group: "shape" },
  move: { label: "Перемещение", icon: "Grab", group: "edit", code: "KeyV", key: "V" },
  eraser: { label: "Ластик", icon: "Eraser", group: "edit", code: "KeyE", key: "E" },
};

export const LINE_VARIANTS: readonly LineVariant[] = ["line", "arrow", "dashed"];
export const SHAPE_VARIANTS: readonly ShapeVariant[] = ["rect", "circle", "triangle", "hexagon"];
// Compact toolbar grid (3 per row): pen marker text / line arrow dashed / rect circle triangle / hexagon move eraser.
export const DRAW_TOOLS: readonly Exclude<Tool, "laser">[] = ["pen", "marker", "text", "line", "arrow", "dashed", "rect", "circle", "triangle", "hexagon", "move", "eraser"];
export const LASER_STYLES: ReadonlyArray<{ readonly value: LaserStyle; readonly label: string }> = [
  { value: "laser", label: "Указка" },
  { value: "ink", label: "Исчезающий карандаш" },
];
export const TEXT_SIZES: ReadonlyArray<{ readonly value: TextSize; readonly short: string; readonly label: string }> = [
  { value: "s", short: "S", label: "Мелкий текст" },
  { value: "m", short: "M", label: "Средний текст" },
  { value: "l", short: "L", label: "Крупный текст" },
];

const CREATING: ReadonlySet<string> = new Set<AnnotationKind>(["pen", "line", "arrow", "dashed", "marker", "rect", "circle", "triangle", "hexagon", "text"]);
const LASER_STYLE_VALUES = LASER_STYLES.map((style) => style.value);
const TEXT_SIZE_VALUES = TEXT_SIZES.map((size) => size.value);
const TOOL_BY_CODE: ReadonlyMap<string, UiTool> = new Map((Object.keys(TOOL_META) as UiTool[]).flatMap((tool) => {
  const code = TOOL_META[tool].code;
  return code && code !== "Escape" ? [[code, tool] as const] : [];
}));

export function isCreatingTool(tool: UiTool): tool is AnnotationKind {
  return CREATING.has(tool);
}

export function variantGroup(tool: UiTool): "line" | "shape" | null {
  const group = TOOL_META[tool]?.group;
  return group === "line" || group === "shape" ? group : null;
}

// Width slider group; null = the tool has no width control. Ink (laser style "ink") draws with widths.pen.
export function widthGroup(tool: UiTool): WidthGroup | null {
  if (tool === "pen" || tool === "marker") return tool;
  return variantGroup(tool) ? "shape" : null;
}

export function toolTitle(tool: UiTool): string {
  const meta = TOOL_META[tool];
  return meta.key ? `${meta.label} (${meta.key})` : meta.label;
}

// Value for aria-keyshortcuts.
export function toolShortcut(tool: UiTool): string | undefined {
  const code = TOOL_META[tool].code;
  if (!code) return undefined;
  return code.startsWith("Key") ? code.slice(3) : code;
}

// Prefs

export type AnnotationPrefs = Readonly<{
  lastDrawTool: AnnotationKind; // always a creating tool; "Рисовать" arms it
  lineVariant: LineVariant;
  shapeVariant: ShapeVariant;
  laserStyle: LaserStyle;
  color: string; // one of PALETTE
  paperColor: string; // one of PALETTE: the ink on white paper (the workspace's board and materials)
  widths: Readonly<Record<WidthGroup, number>>; // int WIDTH_MIN..WIDTH_MAX, reference units
  textSize: TextSize;
  showAuthors: boolean;
  hotkeys: boolean;
  fingersDraw: boolean; // sticky "Пальцы тоже рисуют": a pen-down never switches the frame to penOnly
}>;
export type PrefsPatch = Partial<Omit<AnnotationPrefs, "widths">> & { widths?: Partial<Record<WidthGroup, number>> };

export const DEFAULT_PREFS: AnnotationPrefs = Object.freeze({
  lastDrawTool: "pen",
  lineVariant: "arrow",
  shapeVariant: "rect",
  laserStyle: "laser",
  color: PALETTE[0].value,
  paperColor: "#000000",
  widths: Object.freeze({ pen: 4, marker: 16, shape: 4 }),
  textSize: "m",
  showAuthors: false,
  hotkeys: true,
  fingersDraw: false,
});

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T : fallback;
const bool = (value: unknown, fallback: boolean) => typeof value === "boolean" ? value : fallback;
const width = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) ? Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, Math.round(value))) : fallback;

function paletteColor(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const color = value.trim().toLowerCase();
  return PALETTE.some((choice) => choice.value === color) ? color : fallback;
}

// Field-by-field: anything missing or invalid falls back to the same field of `fallback`.
export function normalizePrefs(value: unknown, fallback: AnnotationPrefs = DEFAULT_PREFS): AnnotationPrefs {
  const input = isRecord(value) ? value : {};
  const widths = isRecord(input.widths) ? input.widths : {};
  return {
    lastDrawTool: typeof input.lastDrawTool === "string" && CREATING.has(input.lastDrawTool) ? input.lastDrawTool as AnnotationKind : fallback.lastDrawTool,
    lineVariant: oneOf(input.lineVariant, LINE_VARIANTS, fallback.lineVariant),
    shapeVariant: oneOf(input.shapeVariant, SHAPE_VARIANTS, fallback.shapeVariant),
    laserStyle: oneOf(input.laserStyle, LASER_STYLE_VALUES, fallback.laserStyle),
    color: paletteColor(input.color, fallback.color),
    paperColor: paletteColor(input.paperColor, fallback.paperColor),
    widths: { pen: width(widths.pen, fallback.widths.pen), marker: width(widths.marker, fallback.widths.marker), shape: width(widths.shape, fallback.widths.shape) },
    textSize: oneOf(input.textSize, TEXT_SIZE_VALUES, fallback.textSize),
    showAuthors: bool(input.showAuthors, fallback.showAuthors),
    hotkeys: bool(input.hotkeys, fallback.hotkeys),
    fingersDraw: bool(input.fingersDraw, fallback.fingersDraw),
  };
}

export function parsePrefs(raw: string | null | undefined): AnnotationPrefs {
  if (!raw) return normalizePrefs(null);
  try {
    return normalizePrefs(JSON.parse(raw));
  } catch {
    return normalizePrefs(null);
  }
}

export function serializePrefs(prefs: AnnotationPrefs): string {
  return JSON.stringify(normalizePrefs(prefs));
}

// Invalid patch values keep the previous value.
export function mergePrefs(prev: AnnotationPrefs, patch: PrefsPatch): AnnotationPrefs {
  return normalizePrefs({ ...prev, ...patch, widths: { ...prev.widths, ...patch.widths } }, prev);
}

export function samePrefs(a: AnnotationPrefs, b: AnnotationPrefs): boolean {
  return a === b || (a.lastDrawTool === b.lastDrawTool && a.lineVariant === b.lineVariant && a.shapeVariant === b.shapeVariant && a.laserStyle === b.laserStyle
    && a.color === b.color && a.paperColor === b.paperColor && a.widths.pen === b.widths.pen && a.widths.marker === b.widths.marker && a.widths.shape === b.widths.shape
    && a.textSize === b.textSize && a.showAuthors === b.showAuthors && a.hotkeys === b.hotkeys && a.fingersDraw === b.fingersDraw);
}

// What selecting `tool` remembers: creating tools become lastDrawTool, line/shape tools also become the group's variant.
export function toolPrefsPatch(tool: UiTool): PrefsPatch {
  if (!isCreatingTool(tool)) return {};
  const group = variantGroup(tool);
  if (group === "line") return { lastDrawTool: tool, lineVariant: tool as LineVariant };
  if (group === "shape") return { lastDrawTool: tool, shapeVariant: tool as ShapeVariant };
  return { lastDrawTool: tool };
}

export function defaultToolFor(input: { armedByDefault: boolean; coarse: boolean; lastDrawTool: UiTool }): UiTool {
  if (!input.armedByDefault || input.coarse) return "view";
  return isCreatingTool(input.lastDrawTool) ? input.lastDrawTool : "pen";
}

// Hotkeys (KeyboardEvent.code, so ЙЦУКЕН and other layouts hit the same physical keys)

export type HotkeyEvent = { code: string; key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean; repeat: boolean; isComposing?: boolean };
// "escape" means "return to Просмотр"; the layer applies the Esc precedence (resolveEscape).
export type HotkeyAction = { type: "tool"; tool: UiTool } | { type: "undo" } | { type: "redo" } | { type: "escape" };

export function hotkeyFor(event: HotkeyEvent): HotkeyAction | null {
  if (event.repeat || event.isComposing || event.key === "Process") return null;
  const code = event.code || (/^[a-z]$/i.test(event.key) ? `Key${event.key.toUpperCase()}` : event.key);
  const mod = event.ctrlKey || event.metaKey;
  if (code === "Escape" || event.key === "Escape") return mod || event.altKey ? null : { type: "escape" };
  if (mod && !event.altKey) {
    if (code === "KeyZ") return { type: event.shiftKey ? "redo" : "undo" };
    if (code === "KeyY" && event.ctrlKey && !event.metaKey && !event.shiftKey) return { type: "redo" };
    return null;
  }
  if (mod || event.altKey || event.shiftKey) return null;
  const tool = TOOL_BY_CODE.get(code);
  return tool ? { type: "tool", tool } : null;
}

// Esc order: an open popover/dialog handles it itself, then an active gesture is cancelled, then Просмотр; in Просмотр it passes on (RoomView leaves expanded mode).
export function resolveEscape(state: { overlayOpen: boolean; gestureActive: boolean; tool: UiTool }): "pass" | "cancel-gesture" | "view" {
  if (state.overlayOpen) return "pass";
  if (state.gestureActive) return "cancel-gesture";
  return state.tool === "view" ? "pass" : "view";
}

// Author chips

const finitePoint = (point: unknown): point is Point => Array.isArray(point) && point.length >= 2 && Number.isFinite(point[0]) && Number.isFinite(point[1]);

// Normalized anchor of a saved mark's chip (use with placeChip prefer "above"): text plate top-left, shapes bbox top-left, lines and freehand the first point.
export function markAnchor(kind: Tool, data: AnnotationPayload): Point | null {
  if (kind === "text" || (data.point && !data.points)) return finitePoint(data.point) ? [data.point[0], data.point[1]] : null;
  const points = data.points?.filter(finitePoint);
  if (!points?.length) return null;
  if (!(SHAPE_VARIANTS as readonly string[]).includes(kind)) return [points[0][0], points[0][1]];
  let minX = Infinity, minY = Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
  }
  return [minX, minY];
}

// Top-left (px) of a chip next to `anchor` (px): right of it, below (cursor label) or above (saved mark); flips at the box edges, then clamps inside.
export function placeChip(anchor: readonly [number, number], box: Size, chip: Size, options: { gap?: number; prefer?: "below" | "above" } = {}): [number, number] {
  const gap = options.gap ?? CHIP_GAP;
  const ax = Number.isFinite(anchor[0]) ? anchor[0] : 0, ay = Number.isFinite(anchor[1]) ? anchor[1] : 0;
  const right = ax + gap, left = ax - gap - chip.width;
  const below = ay + gap, above = ay - gap - chip.height;
  const x = right + chip.width > box.width ? left : right;
  const y = options.prefer === "above" ? (above < 0 ? below : above) : (below + chip.height > box.height ? above : below);
  const clamp = (value: number, max: number) => Math.max(0, Math.min(Math.max(0, max), value));
  return [clamp(x, box.width - chip.width), clamp(y, box.height - chip.height)];
}

// Chip font in screen px (counter-scale by 1/zoom when drawn inside the zoomed frame).
export function chipFontPx(boxHeight: number): number {
  return boxHeight > 0 ? Math.max(9, Math.min(12, boxHeight / 40)) : 9;
}

export function chipName(name: string | null | undefined, fallback = "Участник"): string {
  const clean = (name ?? "").trim().replace(/\s+/g, " ");
  if (!clean) return fallback;
  const chars = Array.from(clean);
  return chars.length > CHIP_MAX_CHARS ? `${chars.slice(0, CHIP_MAX_CHARS).join("").trimEnd()}…` : clean;
}

// Toolbar layout

export type ToolbarPlacement = "row" | "overlay" | "column";
export type ToolbarLayout = Readonly<{ placement: ToolbarPlacement; compact: boolean; orientation: "horizontal" | "vertical" }>;

const LAYOUTS = {
  row: Object.freeze({ placement: "row", compact: false, orientation: "horizontal" }),
  rowCompact: Object.freeze({ placement: "row", compact: true, orientation: "horizontal" }),
  overlay: Object.freeze({ placement: "overlay", compact: false, orientation: "horizontal" }),
  column: Object.freeze({ placement: "column", compact: true, orientation: "vertical" }),
} satisfies Record<string, ToolbarLayout>;

// short = useMediaQuery("(max-height: 520px)") of the window that hosts the toolbar; areaWidth = px the toolbar may take
// (its column minus the placement's margins), <= 0 (not measured yet) counts as wide.
// Returns shared frozen objects, so equal inputs give the same reference.
export function toolbarLayoutFor(input: { expanded: boolean; coarse: boolean; short: boolean; areaWidth: number }): ToolbarLayout {
  if (input.short) return LAYOUTS.column;
  const compact = input.coarse || (input.areaWidth > 0 && input.areaWidth < COMPACT_AREA_WIDTH);
  if (compact) return LAYOUTS.rowCompact;
  return input.expanded ? LAYOUTS.overlay : LAYOUTS.row;
}
