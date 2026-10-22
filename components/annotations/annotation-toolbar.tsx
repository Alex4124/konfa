"use client";

import type { ReactNode, SyntheticEvent } from "react";
import { ArrowUpRight, Check, ChevronDown, Circle, Ellipsis, Eraser, Eye, FlaskConical, Grab, Hexagon, Highlighter, Keyboard, Minus, Pen, RectangleHorizontal, Redo2, Shapes, Sparkles, Trash2, Triangle, Type, Undo2, UserRound, WandSparkles, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
import { unitsToPx } from "@/lib/annotation-geometry";
import { LASER_STYLES, markKindOf, MARKER_OPACITY, OTHER_DRAW_TOOLS, PALETTE, PEN_GROUP_TOOLS, SHAPE_VARIANTS, TEXT_SIZES, TOOL_META, toolShortcut, toolTitle, variantGroup, widthGroup, WIDTH_MAX, WIDTH_MIN, type AnnotationPrefs, type PrefsPatch, type TextSize, type ToolbarLayout, type ToolIconName, type WidthGroup } from "@/lib/annotation-tools";
import type { UiTool } from "@/lib/confa-types";

export type ToolbarPicker = "laser" | "draw" | "shape" | "color" | "tools" | "style" | "more";
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
const activeClass = "bg-primary text-primary-foreground hover:bg-[var(--primary-hover)] hover:text-primary-foreground";
const inactiveClass = "text-foreground hover:bg-accent hover:text-foreground";
const popoverClass = "max-h-(--radix-popover-content-available-height) overflow-y-auto border-border bg-popover p-1.5 text-foreground";
const menuItemClass = "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-40";
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
  const pair = layout.columns === 2; // a landscape phone too short for one column
  const sizeClass = layout.button === 44 ? "size-11" : layout.button === 40 ? "size-10" : ""; // lib/annotation-tools toolbarLayoutFor
  const drawMode = tool !== "view" && tool !== "laser";
  const markKind = markKindOf(tool);
  const styleTool = p.textStyle ? "text" : markKind ?? prefs.lastDrawTool;
  const styleDisabled = !p.textStyle && !markKind;
  const color = p.textStyle?.color ?? prefs.color;
  const textSize = p.textStyle?.size ?? prefs.textSize;
  const group = widthGroup(styleTool);
  const units = group ? prefs.widths[group] : 0;
  const colorLabel = PALETTE.find((choice) => choice.value === color)?.label ?? color;
  const shapeTool = variantGroup(tool) === "shape" ? tool : prefs.shapeVariant;
  const laserLabel = LASER_STYLES.find((style) => style.value === prefs.laserStyle)?.label ?? TOOL_META.laser.label;
  const showFingers = prefs.stylus || prefs.fingersDraw; // only a device that has drawn with a pen tells fingers from the pen

  const pickerProps = (picker: ToolbarPicker) => ({ open: p.openPicker === picker, onOpenChange: (open: boolean) => p.onOpenPicker(open ? picker : null) });
  // The text editor keeps focus while popovers open and close.
  const contentProps = { container: p.portalContainer, side, collisionPadding: 8, onOpenAutoFocus: (event: Event) => { if (p.editingText) event.preventDefault(); }, onCloseAutoFocus: (event: Event) => { if (p.editingText) event.preventDefault(); } } as const;
  const choose = (next: UiTool) => { p.onTool(next); p.onOpenPicker(null); };
  const separator = (key: string) => <span key={key} aria-hidden className={pair ? "col-span-2 my-1 h-px w-full bg-border" : vertical ? "my-1 h-px w-6 shrink-0 bg-border" : "mx-1 h-6 w-px shrink-0 bg-border"} />;

  const toolButton = (next: UiTool, active = tool === next, label = TOOL_META[next].label) => <Button key={next} type="button" variant="ghost" size="icon" title={toolTitle(next)} aria-label={label} aria-pressed={active} aria-keyshortcuts={toolShortcut(next)} className={`${sizeClass} ${active ? activeClass : inactiveClass}`} onClick={() => choose(next)}><ToolIcon tool={next} /></Button>;

  const menuTool = (next: UiTool, onPick = () => choose(next)) => {
    const meta = TOOL_META[next];
    return <button key={next} type="button" aria-pressed={tool === next} title={toolTitle(next)} className={`${menuItemClass} ${tool === next ? "bg-accent" : ""}`} onClick={onPick}><ToolIcon tool={next} /><span className="min-w-0 flex-1">{meta.label}</span></button>;
  };

  // Main button picks the remembered variant; the chevron opens the variants.
  const split = (picker: "shape", main: UiTool, active: boolean, label: string, items: ReactNode) => <Popover key={picker} {...pickerProps(picker)}>
    <div className={`flex items-center ${vertical ? "flex-col" : ""}`}>
      {toolButton(main, active)}
      <PopoverTrigger asChild><Button type="button" variant="ghost" size="icon-xs" title={label} aria-label={label} className={inactiveClass}><ChevronDown size={14} className={vertical ? "-rotate-90" : ""} /></Button></PopoverTrigger>
    </div>
    <PopoverContent {...contentProps} align="start" className={`w-64 ${popoverClass}`} aria-label={label}>{items}</PopoverContent>
  </Popover>;

  const laserItems = LASER_STYLES.map((style) => <button key={style.value} type="button" aria-pressed={tool === "laser" && prefs.laserStyle === style.value} className={`${menuItemClass} ${tool === "laser" && prefs.laserStyle === style.value ? "bg-accent" : ""}`} onClick={() => { p.onPrefs({ laserStyle: style.value }); choose("laser"); }}><LaserIcon ink={style.value === "ink"} /><span className="min-w-0 flex-1">{style.label}</span>{prefs.laserStyle === style.value && <Check size={16} />}</button>);

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

  const penActive = PEN_GROUP_TOOLS.some((next) => next === tool);
  // Keep the same key in both modes so arming the pencil does not unmount the open menu.
  // Prevent Radix's trigger toggle: a repeated click should leave the menu open.
  const drawButton = <Popover key="draw" {...pickerProps("draw")}>
    <PopoverTrigger asChild><Button type="button" variant="ghost" size="icon" title="Карандаш: выбрать инструмент" aria-label="Карандаш и линии" aria-pressed={penActive} aria-keyshortcuts={toolShortcut("pen")} className={`${sizeClass} ${penActive ? activeClass : inactiveClass}`} onClick={(event) => { event.preventDefault(); p.onTool("pen"); p.onOpenPicker("draw"); }}><Pen size={18} /></Button></PopoverTrigger>
    <PopoverContent {...contentProps} align="start" className={`w-64 ${popoverClass}`} aria-label="Карандаш и линии">{PEN_GROUP_TOOLS.map((next) => menuTool(next))}</PopoverContent>
  </Popover>;

  const otherActive = OTHER_DRAW_TOOLS.some((next) => next === tool);
  const otherButton = <Popover key="tools" {...pickerProps("tools")}>
    <PopoverTrigger asChild><Button type="button" variant="ghost" size="icon" title="Другие инструменты" aria-label="Другие инструменты" aria-pressed={otherActive} className={`relative ${sizeClass} ${otherActive ? activeClass : inactiveClass}`}><Shapes size={18} /><ChevronDown size={10} className="absolute bottom-0.5 right-0.5" /></Button></PopoverTrigger>
    <PopoverContent {...contentProps} align="center" className={`w-auto ${popoverClass}`} aria-label="Другие инструменты">
      <div className="grid grid-cols-3 gap-1">{OTHER_DRAW_TOOLS.map((next) => <Button key={next} type="button" variant="ghost" size="icon" title={toolTitle(next)} aria-label={TOOL_META[next].label} aria-pressed={tool === next} className={`size-11 ${tool === next ? activeClass : inactiveClass}`} onClick={() => choose(next)}><ToolIcon tool={next} size={20} /></Button>)}</div>
    </PopoverContent>
  </Popover>;

  const swatches = (close: boolean) => <div className="mx-auto grid w-fit grid-cols-3 gap-2">{PALETTE.map((choice) => <button key={choice.value} type="button" title={choice.label} aria-label={choice.label} aria-pressed={color === choice.value} className={`size-8 rounded-full border-2 outline-none focus-visible:ring-2 focus-visible:ring-primary ${color === choice.value ? "border-foreground" : "border-border"}`} style={{ backgroundColor: choice.value }} onClick={() => { p.onPrefs({ color: choice.value }); if (close) p.onOpenPicker(null); }} />)}</div>;

  const dot = Math.max(2, Math.min(24, unitsToPx(units, p.boxHeight)));
  const widthControl = (wide: boolean) => group
    ? <div key="width" className={`flex shrink-0 items-center gap-2 px-1 text-xs text-foreground ${wide ? "" : "w-41"} ${styleDisabled ? "opacity-40" : ""}`}>
      <Slider aria-label="Толщина линии" title="Толщина линии" className={wide ? "w-40" : "w-24"} min={WIDTH_MIN} max={WIDTH_MAX} step={1} value={[units]} disabled={styleDisabled} onValueChange={(value) => p.onPrefs(widthPatch(group, value[0] ?? units))} />
      <span aria-hidden className="grid size-6 shrink-0 place-items-center"><span className="rounded-full" style={{ width: dot, height: dot, backgroundColor: color, opacity: styleTool === "marker" ? MARKER_OPACITY : 1 }} /></span>
      <span className="w-5 text-right tabular-nums">{units}</span>
    </div>
    : <div key="width" role="group" aria-label="Размер текста" className={`flex shrink-0 items-center justify-center gap-0.5 ${wide ? "" : "w-41"} ${styleDisabled ? "opacity-40" : ""}`}>{TEXT_SIZES.map((size) => <Button key={size.value} type="button" variant="ghost" size="icon-sm" title={size.label} aria-label={size.label} aria-pressed={textSize === size.value} disabled={styleDisabled} className={`text-xs font-semibold ${textSize === size.value ? activeClass : inactiveClass}`} onClick={() => p.onPrefs({ textSize: size.value })}>{size.short}</Button>)}</div>;

  const undoButton = <Button key="undo" type="button" variant="ghost" size="icon" title="Отменить (Ctrl+Z)" aria-label="Отменить" aria-keyshortcuts="Control+Z" className={`${sizeClass} ${inactiveClass}`} disabled={!p.canUndo} onClick={p.onUndo}><Undo2 size={18} /></Button>;
  const redoButton = <Button key="redo" type="button" variant="ghost" size="icon" title="Повторить (Ctrl+Shift+Z)" aria-label="Повторить" aria-keyshortcuts="Control+Shift+Z Control+Y" className={`${sizeClass} ${inactiveClass}`} disabled={!p.canRedo} onClick={p.onRedo}><Redo2 size={18} /></Button>;

  const more = <Popover key="more" {...pickerProps("more")}>
    <PopoverTrigger asChild><Button type="button" variant="ghost" size="icon" title="Ещё" aria-label="Ещё" className={`${sizeClass} ${inactiveClass}`}><Ellipsis size={18} /></Button></PopoverTrigger>
    <PopoverContent {...contentProps} align="end" className={`w-72 ${popoverClass}`} aria-label="Ещё">
      <button type="button" aria-pressed={prefs.showAuthors} className={menuItemClass} onClick={() => p.onPrefs({ showAuthors: !prefs.showAuthors })}><UserRound size={18} /><span className="flex-1">Показывать авторов</span>{prefs.showAuthors && <Check size={16} />}</button>
      {layout.compact && <button type="button" disabled={!p.canRedo} className={menuItemClass} onClick={() => { p.onRedo(); p.onOpenPicker(null); }}><Redo2 size={18} /><span className="flex-1">Повторить</span><span className="text-xs text-muted-foreground">Ctrl+Shift+Z</span></button>}
      {showFingers && <button type="button" aria-pressed={prefs.fingersDraw} className={menuItemClass} onClick={() => p.onFingersDraw(!prefs.fingersDraw)}><Pen size={18} /><span className="flex-1">Пальцы тоже рисуют</span>{prefs.fingersDraw && <Check size={16} />}</button>}
      <button type="button" aria-pressed={prefs.hotkeys} className={menuItemClass} onClick={() => p.onPrefs({ hotkeys: !prefs.hotkeys })}><Keyboard size={18} /><span className="flex-1">Горячие клавиши</span>{prefs.hotkeys && <Check size={16} />}</button>
      {prefs.hotkeys && !coarse && <div className="grid grid-cols-2 gap-x-3 gap-y-1 px-3 pb-2 pt-1 text-xs text-[var(--text-subtle)]">
        {HOTKEY_TOOLS.map((hotkey) => <span key={hotkey} className="flex min-w-0 items-center gap-2"><Kbd className="bg-secondary text-foreground">{TOOL_META[hotkey].key}</Kbd><span className="truncate">{TOOL_META[hotkey].label}</span></span>)}
        <span className="flex items-center gap-2"><Kbd className="bg-secondary text-foreground">Esc</Kbd>Просмотр</span>
        <span className="col-span-2 flex items-center gap-2"><Kbd className="bg-secondary text-foreground">Ctrl+Z</Kbd>/<Kbd className="bg-secondary text-foreground">Ctrl+Shift+Z</Kbd>отменить / повторить</span>
      </div>}
      {p.canModerate && <>
        <div aria-hidden className="my-1 h-px bg-secondary" />
        <button type="button" disabled={!p.markCount} className={`${menuItemClass} text-[var(--danger-text)] hover:bg-rose-500/20 focus-visible:bg-rose-500/20`} onClick={() => { p.onOpenPicker(null); p.onClearRequest(); }}><Trash2 size={18} /><span className="flex-1">{p.clearLabel ?? `Очистить все пометки (${p.markCount})`}</span></button>
      </>}
    </PopoverContent>
  </Popover>;

  let items: ReactNode[];
  if (!drawMode) items = [toolButton("view"), laserButton, separator("s1"), drawButton, ...(layout.compact ? [otherButton] : []), separator("s2"), more];
  else if (layout.compact) {
    items = [
      toolButton("view"), laserButton, separator("s1"),
      drawButton, otherButton,
      <Popover key="style" {...pickerProps("style")}>
        <PopoverTrigger asChild><Button type="button" variant="ghost" size="icon" disabled={styleDisabled} title={`Цвет и толщина: ${colorLabel}`} aria-label={`Цвет и толщина: ${colorLabel}`} className={`${sizeClass} ${inactiveClass}`}><span aria-hidden className="size-6 rounded-full border-2 border-border" style={{ backgroundColor: color }} /></Button></PopoverTrigger>
        <PopoverContent {...contentProps} align="center" className={`w-auto space-y-3 p-3 ${popoverClass}`} aria-label="Цвет и толщина">{swatches(false)}{widthControl(true)}</PopoverContent>
      </Popover>,
      undoButton, more,
    ];
  } else {
    items = [
      toolButton("view"), laserButton, separator("s1"),
      drawButton,
      split("shape", shapeTool, variantGroup(tool) === "shape", "Вид фигуры", SHAPE_VARIANTS.map((next) => menuTool(next))),
      toolButton("text"), toolButton("formula"), separator("s2"),
      toolButton("move"), toolButton("eraser"), separator("s3"),
      <Popover key="color" {...pickerProps("color")}>
        <PopoverTrigger asChild><button type="button" disabled={styleDisabled} title={`Цвет пометок: ${colorLabel}`} aria-label={`Цвет пометок: ${colorLabel}`} className="mx-1 size-7 shrink-0 rounded-full border-2 border-border outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-popover disabled:opacity-40" style={{ backgroundColor: color }} /></PopoverTrigger>
        <PopoverContent {...contentProps} align="center" className={`w-auto p-3 ${popoverClass}`} aria-label="Цвет пометок">{swatches(true)}</PopoverContent>
      </Popover>,
      widthControl(false), separator("s4"),
      undoButton, redoButton, separator("s5"), more,
    ];
  }

  return <div role="toolbar" aria-label="Инструменты пометок" aria-orientation={vertical ? "vertical" : "horizontal"} onPointerDown={keepFocus} onMouseDown={keepFocus} className={`annotation-toolbar touch-manipulation items-center gap-1 rounded-2xl border border-border bg-popover/95 p-1.5 text-foreground shadow-2xl ${pair ? "grid max-h-full grid-cols-2 justify-items-center overflow-y-auto [scrollbar-width:none]" : vertical ? "flex max-h-full flex-col overflow-y-auto [scrollbar-width:none]" : "flex max-w-full overflow-x-auto"}`}>{items}</div>;
}
