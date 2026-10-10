"use client";

import type { ReactNode, SyntheticEvent } from "react";
import { ArrowUpRight, Check, ChevronDown, Circle, Ellipsis, Eraser, Eye, FlaskConical, Grab, Hexagon, Highlighter, Keyboard, Minus, Pen, RectangleHorizontal, Redo2, Sparkles, Trash2, Triangle, Type, Undo2, UserRound, WandSparkles, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
import { unitsToPx } from "@/lib/annotation-geometry";
import { DRAW_TOOLS, LASER_STYLES, LINE_VARIANTS, markKindOf, MARKER_OPACITY, PALETTE, SHAPE_VARIANTS, TEXT_SIZES, TOOL_META, toolShortcut, toolTitle, variantGroup, widthGroup, WIDTH_MAX, WIDTH_MIN, type AnnotationPrefs, type PrefsPatch, type TextSize, type ToolbarLayout, type ToolIconName, type WidthGroup } from "@/lib/annotation-tools";
import type { UiTool } from "@/lib/confa-types";

export type ToolbarPicker = "laser" | "line" | "shape" | "color" | "tools" | "style" | "more";
type Props = {
  tool: UiTool;
  prefs: AnnotationPrefs;
  layout: ToolbarLayout;
  coarse: boolean;
  canModerate: boolean;
  markCount: number;
  clearLabel?: string; // instead of «Очистить все пометки (N)» (the workspace: the whole board, a material's page)
  canUndo: boolean;
  canRedo: boolean;
  penOnly: boolean;
  boxHeight: number; // frame height, for the width preview dot
  editingText: boolean;
  textStyle?: { color: string; size: TextSize } | null; // the open text editor's look: the style controls show and change it
  openPicker: ToolbarPicker | null;
  portalContainer?: HTMLElement | null;
  onOpenPicker: (picker: ToolbarPicker | null) => void;
  onTool: (tool: UiTool) => void;
  onPrefs: (patch: PrefsPatch) => void;
  onUndo: () => void;
  onRedo: () => void;
  onClearRequest: () => void;
  onFingersDraw: (enabled: boolean) => void;
};

const ICONS: Record<ToolIconName, LucideIcon> = { Eye, WandSparkles, Pen, Highlighter, Minus, ArrowUpRight, RectangleHorizontal, Circle, Triangle, Hexagon, Type, FlaskConical, Grab, Eraser };
const HOTKEY_TOOLS = (Object.keys(TOOL_META) as UiTool[]).filter((tool) => tool !== "view" && TOOL_META[tool].key);
const activeClass = "bg-[#6de7d4] text-[#10243a] hover:bg-[#96f5e7] hover:text-[#10243a]";
const inactiveClass = "text-white hover:bg-white/10 hover:text-white";
const popoverClass = "border-white/15 bg-[#1c2c45] p-1.5 text-white";
const menuItemClass = "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm outline-none hover:bg-white/10 focus-visible:bg-white/10 disabled:pointer-events-none disabled:opacity-40";
const keepFocus = (event: SyntheticEvent) => event.preventDefault();

function widthPatch(group: WidthGroup, value: number): PrefsPatch {
  return { widths: { [group]: value } as Partial<Record<WidthGroup, number>> };
}

function ToolIcon({ tool, size = 18 }: { tool: UiTool; size?: number }) {
  const meta = TOOL_META[tool];
  const Icon = ICONS[meta.icon];
  return <Icon size={size} strokeDasharray={meta.dashed ? "3 3" : undefined} />;
}

function LaserIcon({ ink }: { ink: boolean }) {
  return ink ? <Sparkles size={18} /> : <WandSparkles size={18} />;
}

export function AnnotationToolbar(p: Props) {
  const { tool, prefs, layout, coarse } = p;
  const vertical = layout.orientation === "vertical";
  const side = vertical ? "right" : "top";
  const sizeClass = layout.compact && coarse ? "size-11" : "";
  const drawMode = tool !== "view" && tool !== "laser";
  const markKind = markKindOf(tool);
  const styleTool = p.textStyle ? "text" : markKind ?? prefs.lastDrawTool;
  const styleDisabled = !p.textStyle && !markKind;
  const color = p.textStyle?.color ?? prefs.color;
  const textSize = p.textStyle?.size ?? prefs.textSize;
  const group = widthGroup(styleTool);
  const units = group ? prefs.widths[group] : 0;
  const colorLabel = PALETTE.find((choice) => choice.value === color)?.label ?? color;
  const lineTool = variantGroup(tool) === "line" ? tool : prefs.lineVariant;
  const shapeTool = variantGroup(tool) === "shape" ? tool : prefs.shapeVariant;
  const laserLabel = LASER_STYLES.find((style) => style.value === prefs.laserStyle)?.label ?? TOOL_META.laser.label;
  const showFingers = p.penOnly || prefs.fingersDraw;

  const pickerProps = (picker: ToolbarPicker) => ({ open: p.openPicker === picker, onOpenChange: (open: boolean) => p.onOpenPicker(open ? picker : null) });
  // The text editor keeps focus while popovers open and close.
  const contentProps = { container: p.portalContainer, side, collisionPadding: 8, onOpenAutoFocus: (event: Event) => { if (p.editingText) event.preventDefault(); }, onCloseAutoFocus: (event: Event) => { if (p.editingText) event.preventDefault(); } } as const;
  const choose = (next: UiTool) => { p.onTool(next); p.onOpenPicker(null); };
  const separator = (key: string) => <span key={key} aria-hidden className={vertical ? "my-1 h-px w-6 shrink-0 bg-white/20" : "mx-1 h-6 w-px shrink-0 bg-white/20"} />;

  const toolButton = (next: UiTool, active = tool === next, label = TOOL_META[next].label) => <Button key={next} type="button" variant="ghost" size="icon" title={toolTitle(next)} aria-label={label} aria-pressed={active} aria-keyshortcuts={toolShortcut(next)} className={`${sizeClass} ${active ? activeClass : inactiveClass}`} onClick={() => choose(next)}><ToolIcon tool={next} /></Button>;

  const menuTool = (next: UiTool, onPick = () => choose(next)) => {
    const meta = TOOL_META[next];
    return <button key={next} type="button" aria-pressed={tool === next} title={toolTitle(next)} className={`${menuItemClass} ${tool === next ? "bg-white/10" : ""}`} onClick={onPick}><ToolIcon tool={next} /><span className="min-w-0 flex-1">{meta.label}</span></button>;
  };

  // Main button picks the remembered variant; the chevron opens the variants.
  const split = (picker: "line" | "shape", main: UiTool, active: boolean, label: string, items: ReactNode) => <Popover key={picker} {...pickerProps(picker)}>
    <div className={`flex items-center ${vertical ? "flex-col" : ""}`}>
      {toolButton(main, active)}
      <PopoverTrigger asChild><Button type="button" variant="ghost" size="icon-xs" title={label} aria-label={label} className={inactiveClass}><ChevronDown size={14} className={vertical ? "-rotate-90" : ""} /></Button></PopoverTrigger>
    </div>
    <PopoverContent {...contentProps} align="start" className={`w-64 ${popoverClass}`} aria-label={label}>{items}</PopoverContent>
  </Popover>;

  const laserItems = LASER_STYLES.map((style) => <button key={style.value} type="button" aria-pressed={tool === "laser" && prefs.laserStyle === style.value} className={`${menuItemClass} ${tool === "laser" && prefs.laserStyle === style.value ? "bg-white/10" : ""}`} onClick={() => { p.onPrefs({ laserStyle: style.value }); choose("laser"); }}><LaserIcon ink={style.value === "ink"} /><span className="min-w-0 flex-1">{style.label}</span>{prefs.laserStyle === style.value && <Check size={16} />}</button>);

  // Compact: the laser button selects the laser, and once it is selected opens the laser variants.
  const laserButton = layout.compact
    ? <Popover key="laser" {...pickerProps("laser")}>
      <PopoverTrigger asChild><Button type="button" variant="ghost" size="icon" title={tool === "laser" ? `${laserLabel}: выбрать вид` : toolTitle("laser")} aria-label={laserLabel} aria-pressed={tool === "laser"} aria-keyshortcuts={toolShortcut("laser")} className={`relative ${sizeClass} ${tool === "laser" ? activeClass : inactiveClass}`} onClick={(event) => { if (tool !== "laser") { event.preventDefault(); choose("laser"); } }}><LaserIcon ink={prefs.laserStyle === "ink"} />{tool === "laser" && <ChevronDown size={10} className="absolute bottom-0.5 right-0.5" />}</Button></PopoverTrigger>
      <PopoverContent {...contentProps} align="start" className={`w-60 ${popoverClass}`} aria-label="Вид указки">{laserItems}</PopoverContent>
    </Popover>
    : <Popover key="laser" {...pickerProps("laser")}>
      <div className={`flex items-center ${vertical ? "flex-col" : ""}`}>
        <Button type="button" variant="ghost" size="icon" title={toolTitle("laser")} aria-label={laserLabel} aria-pressed={tool === "laser"} aria-keyshortcuts={toolShortcut("laser")} className={`${sizeClass} ${tool === "laser" ? activeClass : inactiveClass}`} onClick={() => choose("laser")}><LaserIcon ink={prefs.laserStyle === "ink"} /></Button>
        <PopoverTrigger asChild><Button type="button" variant="ghost" size="icon-xs" title="Вид указки" aria-label="Вид указки" className={inactiveClass}><ChevronDown size={14} className={vertical ? "-rotate-90" : ""} /></Button></PopoverTrigger>
      </div>
      <PopoverContent {...contentProps} align="start" className={`w-60 ${popoverClass}`} aria-label="Вид указки">{laserItems}</PopoverContent>
    </Popover>;

  const drawButton = <Button key="draw" type="button" variant="ghost" size={layout.compact ? "icon" : "sm"} title={`Рисовать: ${TOOL_META[prefs.lastDrawTool].label}`} aria-label="Рисовать" className={`${sizeClass} ${inactiveClass}`} onClick={() => choose(prefs.lastDrawTool)}><ToolIcon tool={prefs.lastDrawTool} />{!layout.compact && "Рисовать"}</Button>;

  const swatches = (close: boolean) => <div className="grid grid-cols-6 gap-2">{PALETTE.map((choice) => <button key={choice.value} type="button" title={choice.label} aria-label={choice.label} aria-pressed={color === choice.value} className={`size-8 rounded-full border-2 outline-none focus-visible:ring-2 focus-visible:ring-[#6de7d4] ${color === choice.value ? "border-white" : "border-white/30"}`} style={{ backgroundColor: choice.value }} onClick={() => { p.onPrefs({ color: choice.value }); if (close) p.onOpenPicker(null); }} />)}</div>;

  const dot = Math.max(2, Math.min(24, unitsToPx(units, p.boxHeight)));
  const widthControl = (wide: boolean) => group
    ? <div key="width" className={`flex shrink-0 items-center gap-2 px-1 text-xs text-white ${styleDisabled ? "opacity-40" : ""}`}>
      <Slider aria-label="Толщина линии" title="Толщина линии" className={wide ? "w-40" : "w-24"} min={WIDTH_MIN} max={WIDTH_MAX} step={1} value={[units]} disabled={styleDisabled} onValueChange={(value) => p.onPrefs(widthPatch(group, value[0] ?? units))} />
      <span aria-hidden className="grid size-6 shrink-0 place-items-center"><span className="rounded-full" style={{ width: dot, height: dot, backgroundColor: color, opacity: styleTool === "marker" ? MARKER_OPACITY : 1 }} /></span>
      <span className="w-5 text-right tabular-nums">{units}</span>
    </div>
    : <div key="width" role="group" aria-label="Размер текста" className={`flex shrink-0 items-center gap-0.5 ${styleDisabled ? "opacity-40" : ""}`}>{TEXT_SIZES.map((size) => <Button key={size.value} type="button" variant="ghost" size="icon-sm" title={size.label} aria-label={size.label} aria-pressed={textSize === size.value} disabled={styleDisabled} className={`text-xs font-semibold ${textSize === size.value ? activeClass : inactiveClass}`} onClick={() => p.onPrefs({ textSize: size.value })}>{size.short}</Button>)}</div>;

  const undoButton = <Button key="undo" type="button" variant="ghost" size="icon" title="Отменить (Ctrl+Z)" aria-label="Отменить" aria-keyshortcuts="Control+Z" className={`${sizeClass} ${inactiveClass}`} disabled={!p.canUndo} onClick={p.onUndo}><Undo2 size={18} /></Button>;
  const redoButton = <Button key="redo" type="button" variant="ghost" size="icon" title="Повторить (Ctrl+Shift+Z)" aria-label="Повторить" aria-keyshortcuts="Control+Shift+Z Control+Y" className={`${sizeClass} ${inactiveClass}`} disabled={!p.canRedo} onClick={p.onRedo}><Redo2 size={18} /></Button>;

  const more = <Popover key="more" {...pickerProps("more")}>
    <PopoverTrigger asChild><Button type="button" variant="ghost" size="icon" title="Ещё" aria-label="Ещё" className={`${sizeClass} ${inactiveClass}`}><Ellipsis size={18} /></Button></PopoverTrigger>
    <PopoverContent {...contentProps} align="end" className={`w-72 ${popoverClass}`} aria-label="Ещё">
      <button type="button" aria-pressed={prefs.showAuthors} className={menuItemClass} onClick={() => p.onPrefs({ showAuthors: !prefs.showAuthors })}><UserRound size={18} /><span className="flex-1">Показывать авторов</span>{prefs.showAuthors && <Check size={16} />}</button>
      {layout.compact && <button type="button" disabled={!p.canRedo} className={menuItemClass} onClick={() => { p.onRedo(); p.onOpenPicker(null); }}><Redo2 size={18} /><span className="flex-1">Повторить</span><span className="text-xs text-slate-400">Ctrl+Shift+Z</span></button>}
      {showFingers && <button type="button" aria-pressed={prefs.fingersDraw} className={menuItemClass} onClick={() => p.onFingersDraw(!prefs.fingersDraw)}><Pen size={18} /><span className="flex-1">Пальцы тоже рисуют</span>{prefs.fingersDraw && <Check size={16} />}</button>}
      <button type="button" aria-pressed={prefs.hotkeys} className={menuItemClass} onClick={() => p.onPrefs({ hotkeys: !prefs.hotkeys })}><Keyboard size={18} /><span className="flex-1">Горячие клавиши</span>{prefs.hotkeys && <Check size={16} />}</button>
      {prefs.hotkeys && !coarse && <div className="grid grid-cols-2 gap-x-3 gap-y-1 px-3 pb-2 pt-1 text-xs text-slate-300">
        {HOTKEY_TOOLS.map((hotkey) => <span key={hotkey} className="flex min-w-0 items-center gap-2"><Kbd className="bg-white/10 text-white">{TOOL_META[hotkey].key}</Kbd><span className="truncate">{TOOL_META[hotkey].label}</span></span>)}
        <span className="flex items-center gap-2"><Kbd className="bg-white/10 text-white">Esc</Kbd>Просмотр</span>
        <span className="col-span-2 flex items-center gap-2"><Kbd className="bg-white/10 text-white">Ctrl+Z</Kbd>/<Kbd className="bg-white/10 text-white">Ctrl+Shift+Z</Kbd>отменить / повторить</span>
      </div>}
      {p.canModerate && <>
        <div aria-hidden className="my-1 h-px bg-white/10" />
        <button type="button" disabled={!p.markCount} className={`${menuItemClass} text-rose-200 hover:bg-rose-500/20 focus-visible:bg-rose-500/20`} onClick={() => { p.onOpenPicker(null); p.onClearRequest(); }}><Trash2 size={18} /><span className="flex-1">{p.clearLabel ?? `Очистить все пометки (${p.markCount})`}</span></button>
      </>}
    </PopoverContent>
  </Popover>;

  let items: ReactNode[];
  if (!drawMode) items = [toolButton("view"), laserButton, separator("s1"), drawButton, separator("s2"), more];
  else if (layout.compact) {
    const current = markKind || tool === "move" || tool === "eraser" ? tool : prefs.lastDrawTool;
    items = [
      toolButton("view"), laserButton, separator("s1"),
      <Popover key="tools" {...pickerProps("tools")}>
        <PopoverTrigger asChild><Button type="button" variant="ghost" size="icon" title={`${toolTitle(current)}: другой инструмент`} aria-label={`Инструмент: ${TOOL_META[current].label}`} className={`relative ${sizeClass} ${activeClass}`}><ToolIcon tool={current} /><ChevronDown size={10} className="absolute bottom-0.5 right-0.5" /></Button></PopoverTrigger>
        <PopoverContent {...contentProps} align="center" className={`w-auto ${popoverClass}`} aria-label="Инструменты">
          <div className="grid grid-cols-3 gap-1">{DRAW_TOOLS.map((next) => <Button key={next} type="button" variant="ghost" size="icon" title={toolTitle(next)} aria-label={TOOL_META[next].label} aria-pressed={tool === next} className={`size-11 ${tool === next ? activeClass : inactiveClass}`} onClick={() => choose(next)}><ToolIcon tool={next} size={20} /></Button>)}</div>
        </PopoverContent>
      </Popover>,
      <Popover key="style" {...pickerProps("style")}>
        <PopoverTrigger asChild><Button type="button" variant="ghost" size="icon" disabled={styleDisabled} title={`Цвет и толщина: ${colorLabel}`} aria-label={`Цвет и толщина: ${colorLabel}`} className={`${sizeClass} ${inactiveClass}`}><span aria-hidden className="size-6 rounded-full border-2 border-white/80" style={{ backgroundColor: color }} /></Button></PopoverTrigger>
        <PopoverContent {...contentProps} align="center" className={`w-auto space-y-3 p-3 ${popoverClass}`} aria-label="Цвет и толщина">{swatches(false)}{widthControl(true)}</PopoverContent>
      </Popover>,
      undoButton, more,
    ];
  } else {
    items = [
      toolButton("view"), laserButton, separator("s1"),
      toolButton("pen"), toolButton("marker"),
      split("line", lineTool, variantGroup(tool) === "line", "Вид линии", LINE_VARIANTS.map((next) => menuTool(next))),
      split("shape", shapeTool, variantGroup(tool) === "shape", "Вид фигуры", SHAPE_VARIANTS.map((next) => menuTool(next))),
      toolButton("text"), toolButton("formula"), separator("s2"),
      toolButton("move"), toolButton("eraser"), separator("s3"),
      <Popover key="color" {...pickerProps("color")}>
        <PopoverTrigger asChild><button type="button" disabled={styleDisabled} title={`Цвет пометок: ${colorLabel}`} aria-label={`Цвет пометок: ${colorLabel}`} className="mx-1 size-7 shrink-0 rounded-full border-2 border-white/80 outline-none focus-visible:ring-2 focus-visible:ring-[#6de7d4] focus-visible:ring-offset-2 focus-visible:ring-offset-[#12243a] disabled:opacity-40" style={{ backgroundColor: color }} /></PopoverTrigger>
        <PopoverContent {...contentProps} align="center" className={`w-auto p-3 ${popoverClass}`} aria-label="Цвет пометок">{swatches(true)}</PopoverContent>
      </Popover>,
      widthControl(false), separator("s4"),
      undoButton, redoButton, separator("s5"), more,
    ];
  }

  return <div role="toolbar" aria-label="Инструменты пометок" aria-orientation={vertical ? "vertical" : "horizontal"} onPointerDown={keepFocus} onMouseDown={keepFocus} className={`annotation-toolbar flex touch-manipulation items-center gap-1 rounded-2xl border border-white/15 bg-[#12243a]/95 p-1.5 shadow-2xl ${vertical ? "max-h-full flex-col overflow-y-auto" : "max-w-full overflow-x-auto"}`}>{items}</div>;
}
