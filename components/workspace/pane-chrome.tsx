"use client";

import type { DragEvent, ReactNode } from "react";
import { ChevronLeft, ChevronRight, FileText, LoaderCircle, type LucideProps, PanelBottomClose, PanelBottomOpen, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, PanelTopClose, PanelTopOpen, Presentation } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AnnotationSync } from "@/hooks/use-annotation-sync";
import type { FrameInteraction } from "@/components/zoom-frame";
import type { ToolbarLayout } from "@/lib/annotation-tools";

export type WorkspacePart = "board" | "doc";
export type Orientation = "row" | "column";
// The annotation layer's inputs shared by both parts (each part has its own sync).
export type WorkspaceLayerProps = { sync: AnnotationSync; selfId: string; canDraw: boolean; canModerate: boolean; armedByDefault: boolean; coarse: boolean };
export type WorkspaceHostActions = {
  flip(part: WorkspacePart, page: number): void;
  addBoardPage(): void;
  collapse(part: WorkspacePart, collapsed: boolean): void;
  setAllDraw(enabled: boolean): void;
  selectDoc(docId: string): void;
  closeDoc(): void;
  deleteDoc(docId: string, name: string): void;
  uploadFile(file: File): void;
  cancelUpload(): void;
};
// What a part needs to draw: the shared tool key and frame interaction, and the toolbar while it is the active part.
export type PaneDrawing = { toolKey: string; interaction: FrameInteraction; fingersDraw: boolean; toolbar: { container: HTMLElement | null; layout: ToolbarLayout } | undefined; active: boolean };

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

// «‹ Лист 2 / 3 ›»: the teacher turns pages, students only see the number.
export function PageNav({ label, page, count, onFlip }: { label: string; page: number; count: number; onFlip?: (page: number) => void }) {
  const text = <span className="whitespace-nowrap px-1 text-xs tabular-nums text-slate-300"><span className="max-sm:hidden">{label} </span>{page + 1} / {count}</span>;
  if (!onFlip) return text;
  return <div className="flex items-center" role="group" aria-label={`${label}: ${page + 1} из ${count}`}>
    <Button type="button" variant="ghost" size="icon-sm" title="Назад" aria-label="Назад" disabled={page <= 0} className={headerButton} onClick={() => onFlip(page - 1)}><ChevronLeft /></Button>
    {text}
    <Button type="button" variant="ghost" size="icon-sm" title="Вперёд" aria-label="Вперёд" disabled={page >= count - 1} className={headerButton} onClick={() => onFlip(page + 1)}><ChevronRight /></Button>
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
