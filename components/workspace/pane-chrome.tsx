"use client";

import { useState, type DragEvent, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, FileText, LoaderCircle, type LucideProps, PanelBottomClose, PanelBottomOpen, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, PanelTopClose, PanelTopOpen, Presentation } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { FrameInteraction } from "@/components/zoom-frame";
import type { StripApi } from "@/components/workspace/scroll-strip-view";
import type { TextSize } from "@/lib/annotation-tools";
import type { SurfaceHub } from "@/lib/surface-hub";
import type { PartView } from "@/lib/view-sync";

export type WorkspacePart = "board" | "doc";
export type Orientation = "row" | "column";
// The annotation layers' inputs shared by every tile of both parts (each tile takes its store from the hub).
export type WorkspaceLayerProps = { hub: SurfaceHub; selfId: string; canDraw: boolean; canModerate: boolean; armedByDefault: boolean; coarse: boolean };
export type WorkspaceHostActions = {
  clearBoard(): void;
  collapse(part: WorkspacePart, collapsed: boolean): void;
  setAllDraw(enabled: boolean): void;
  selectDoc(docId: string): void;
  closeDoc(): void;
  deleteDoc(docId: string, name: string): void;
  uploadFile(file: File): void;
  cancelUpload(): void;
};
// What a part needs to draw: the tool key and ink both parts share, the frame interaction, and the pen-only flag (one for both).
export type PaneDrawing = { toolKey: string; color: string; interaction: FrameInteraction; fingersDraw: boolean; penOnly: boolean; onPenOnlyChange(value: boolean): void; seams: boolean };
// How a part follows the teacher: the teacher's own view goes out through `report`, everyone else is held to `target`.
export type PaneFollow = { target: { pos: number; span: number | null } | null; report?: (view: PartView, settled: boolean) => void };
// What the workspace asks of a part: its strip, and (the material) the page a "clear" would act on.
export type PaneApi = { strip: StripApi | null; current?: () => number };
export type PaneEditing = (part: WorkspacePart, style: { color: string; size: TextSize } | null) => void;

export const PART_LABEL: Record<WorkspacePart, string> = { board: "Доска", doc: "Материалы" };
export const headerButton = "text-slate-200 hover:bg-white/10 hover:text-white";

// The board sits on the start side (left, or top when stacked), the material on the end side.
function PanelIcon({ part, orientation, open, ...props }: { part: WorkspacePart; orientation: Orientation; open: boolean } & LucideProps) {
  if (part === "board" && orientation === "row") return open ? <PanelLeftOpen {...props} /> : <PanelLeftClose {...props} />;
  if (part === "board") return open ? <PanelTopOpen {...props} /> : <PanelTopClose {...props} />;
  if (orientation === "row") return open ? <PanelRightOpen {...props} /> : <PanelRightClose {...props} />;
  return open ? <PanelBottomOpen {...props} /> : <PanelBottomClose {...props} />;
}

function PartIcon({ part, ...props }: { part: WorkspacePart } & LucideProps) {
  return part === "board" ? <Presentation {...props} /> : <FileText {...props} />;
}

export function CollapseButton({ part, orientation, onClick }: { part: WorkspacePart; orientation: Orientation; onClick: () => void }) {
  const label = part === "board" ? "Свернуть доску у всех" : "Свернуть материалы у всех";
  return <Button type="button" variant="ghost" size="icon-sm" title={label} aria-label={label} className={headerButton} onClick={onClick}><PanelIcon part={part} orientation={orientation} open={false} /></Button>;
}

// «‹ 3 / 12 ›»: where the view is. The teacher steps to the neighbouring page or types a page number; students only see it.
export function PageJump({ page, count, onJump }: { page: number; count: number; onJump?: (page: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  if (!onJump) return <span className="whitespace-nowrap px-1 text-xs tabular-nums text-slate-300"><span className="max-sm:hidden">Стр. </span>{page + 1} / {count}</span>;
  const go = () => {
    const wanted = Number.parseInt(draft ?? "", 10);
    setDraft(null);
    if (Number.isFinite(wanted)) onJump(Math.min(count, Math.max(1, wanted)) - 1);
  };
  return <div className="flex items-center" role="group" aria-label={`Страница ${page + 1} из ${count}`}>
    <Button type="button" variant="ghost" size="icon-sm" title="Предыдущая страница" aria-label="Предыдущая страница" disabled={page <= 0} className={headerButton} onClick={() => onJump(page - 1)}><ChevronLeft /></Button>
    <input aria-label="Номер страницы" inputMode="numeric" value={draft ?? String(page + 1)} title="Введите номер страницы и нажмите Enter"
      className="h-7 w-9 rounded-md border border-white/15 bg-[#0e192c] text-center text-xs tabular-nums text-white outline-none focus:border-[#6de7d4]"
      onFocus={(event) => { setDraft(String(page + 1)); event.currentTarget.select(); }}
      onChange={(event) => setDraft(event.target.value.replace(/\D/g, "").slice(0, 3))}
      onBlur={() => setDraft(null)}
      onKeyDown={(event) => {
        if (event.key === "Enter") { go(); event.currentTarget.blur(); }
        else if (event.key === "Escape") { setDraft(null); event.currentTarget.blur(); }
        event.stopPropagation();
      }} />
    <span className="whitespace-nowrap px-1 text-xs tabular-nums text-slate-300">/ {count}</span>
    <Button type="button" variant="ghost" size="icon-sm" title="Следующая страница" aria-label="Следующая страница" disabled={page >= count - 1} className={headerButton} onClick={() => onJump(page + 1)}><ChevronRight /></Button>
  </div>;
}

type ShellProps = {
  part: WorkspacePart;
  title: string;
  controls?: ReactNode;
  highlight: boolean; // the active part, when the toolbar can act on either
  onActivate: (part: WorkspacePart) => void;
  children: ReactNode;
  dropProps?: { onDragOver(event: DragEvent): void; onDragLeave(event: DragEvent): void; onDrop(event: DragEvent): void };
};

export function PaneShell({ part, title, controls, highlight, onActivate, children, dropProps }: ShellProps) {
  return <section aria-label={PART_LABEL[part]} onPointerDownCapture={() => onActivate(part)} onFocusCapture={() => onActivate(part)} {...dropProps}
    className={`relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border bg-[#14243a] transition-colors ${highlight ? "border-[#6de7d4]/55" : "border-white/10"}`}>
    <header className="flex h-10 shrink-0 items-center gap-1.5 border-b border-white/10 pl-3 pr-1">
      <PartIcon part={part} size={16} className="shrink-0 text-[#9af4e7]" />
      <h2 className="min-w-0 flex-1 truncate text-sm font-medium" title={title}>{title}</h2>
      <div className="flex shrink-0 items-center gap-0.5">{controls}</div>
    </header>
    <div className="relative min-h-0 flex-1 bg-[#0b1626]">{children}</div>
  </section>;
}

// A collapsed part: a slim strip at its side of the screen. Only the teacher can open it again (for everyone).
export function PaneRail({ part, orientation, onExpand, busy = false }: { part: WorkspacePart; orientation: Orientation; onExpand?: () => void; busy?: boolean }) {
  const vertical = orientation === "row";
  const label = PART_LABEL[part];
  const content = <>
    {busy ? <LoaderCircle size={18} className="animate-spin text-[#9af4e7]" /> : <PartIcon part={part} size={18} className="text-[#9af4e7]" />}
    <span className={`text-xs font-medium ${vertical ? "rotate-180 [writing-mode:vertical-rl]" : ""}`}>{label}</span>
    {onExpand && <PanelIcon part={part} orientation={orientation} open size={16} className={vertical ? "mt-auto" : "ml-auto"} />}
  </>;
  const shape = `flex shrink-0 items-center gap-2 rounded-xl border border-white/10 bg-[#14243a] text-slate-200 ${vertical ? "w-11 flex-col py-3" : "h-11 flex-row px-3"}`;
  if (!onExpand) return <div role="note" title={`Учитель свернул: ${label.toLowerCase()}`} className={shape}>{content}</div>;
  const action = part === "board" ? "Развернуть доску у всех" : "Развернуть материалы у всех";
  return <button type="button" title={action} aria-label={action} className={`${shape} outline-none hover:bg-[#1c3150] hover:text-white focus-visible:ring-2 focus-visible:ring-[#6de7d4]`} onClick={onExpand}>{content}</button>;
}
