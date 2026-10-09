"use client";

import { useEffect, useRef, useState, type DragEvent } from "react";
import { Check, FileText, FolderOpen, LoaderCircle, Trash, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { AnnotationLayer } from "@/components/annotations/annotation-layer";
import { ZoomFrame } from "@/components/zoom-frame";
import { CollapseButton, headerButton, PageNav, PaneShell, type Orientation, type PaneDrawing, type WorkspaceHostActions, type WorkspaceLayerProps, type WorkspacePart } from "@/components/workspace/pane-chrome";
import type { MaterialUpload } from "@/hooks/use-material-upload";
import type { WorkspaceDoc, WorkspaceView } from "@/lib/confa-types";

const ACCEPT = ".pdf,.pptx,.ppt,.odp,.docx,.doc,.odt,.rtf,.png,.jpg,.jpeg,.webp,application/pdf,image/png,image/jpeg,image/webp";
const menuItem = "flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm outline-none hover:bg-white/10 focus-visible:bg-white/10 disabled:pointer-events-none disabled:opacity-40";

function pageUrl(roomId: string, doc: Pick<WorkspaceDoc, "id" | "token">, page: number): string {
  return `/api/rooms/${roomId}/documents/${doc.id}/pages/${page}?t=${encodeURIComponent(doc.token)}`;
}

// The current page as a plain image (the signed link caches for a day); the next page is fetched ahead.
function PageImage({ roomId, doc }: { roomId: string; doc: WorkspaceDoc }) {
  const src = pageUrl(roomId, doc, doc.page);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const { id, token, page, pageCount } = doc;
  useEffect(() => {
    if (page + 1 >= pageCount) return;
    const next = new Image();
    next.decoding = "async";
    next.src = pageUrl(roomId, { id, token }, page + 1);
  }, [roomId, id, token, page, pageCount]);
  return <>
    {/* eslint-disable-next-line @next/next/no-img-element -- a signed, private page image */}
    <img key={src} src={src} alt="" draggable={false} decoding="async" onLoad={() => setLoaded(src)} onError={() => setFailed(src)} className="pointer-events-none absolute inset-0 h-full w-full select-none object-fill" />
    {loaded !== src && failed !== src && <div className="absolute inset-0 grid place-items-center bg-white"><LoaderCircle className="size-6 animate-spin text-slate-400" /></div>}
    {failed === src && <div className="absolute inset-0 grid place-items-center bg-white p-4 text-center text-sm text-slate-500">Не удалось загрузить страницу</div>}
  </>;
}

function uploadText(upload: MaterialUpload): string {
  const name = `«${upload.name}»`;
  const progress = upload.progress;
  if (progress?.stage === "convert") return `Преобразуем ${name} в PDF…`;
  if (progress?.stage === "upload") return `Загружаем ${name}: ${progress.done} из ${progress.total}`;
  if (progress?.stage === "finish") return `Готовим ${name}…`;
  return `Открываем ${name}…`;
}

function UploadBanner({ upload, onCancel }: { upload: MaterialUpload; onCancel: () => void }) {
  const progress = upload.progress;
  const share = progress?.stage === "upload" && progress.total > 0 ? progress.done / progress.total : progress?.stage === "finish" ? 1 : null;
  return <div role="status" className="absolute inset-x-2 top-2 z-30 flex items-center gap-3 rounded-lg border border-white/15 bg-[#1c2c45]/95 px-3 py-2 text-sm shadow-xl">
    <LoaderCircle size={18} className="shrink-0 animate-spin text-[#9af4e7]" />
    <div className="min-w-0 flex-1">
      <p className="truncate">{uploadText(upload)}</p>
      {share !== null && <div className="mt-1.5 h-1 overflow-hidden rounded bg-white/10"><div className="h-full bg-[#6de7d4] transition-[width]" style={{ width: `${Math.round(share * 100)}%` }} /></div>}
    </div>
    <Button type="button" variant="ghost" size="sm" className={headerButton} onClick={onCancel}>Отменить</Button>
  </div>;
}

function MaterialsMenu({ view, host, busy, onPick }: { view: WorkspaceView; host: WorkspaceHostActions; busy: boolean; onPick: () => void }) {
  const [open, setOpen] = useState(false);
  const documents = view.documents ?? [];
  const run = (action: () => void) => { setOpen(false); action(); };
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild><Button type="button" variant="ghost" size="sm" title="Материалы урока" className={headerButton}><FolderOpen /><span className="max-lg:hidden">Материалы</span></Button></PopoverTrigger>
    <PopoverContent align="end" collisionPadding={8} className="w-72 border-white/15 bg-[#1c2c45] p-1.5 text-white">
      <button type="button" disabled={busy} className={menuItem} onClick={() => run(onPick)}><Upload size={16} />Загрузить файл…</button>
      {documents.length > 0 && <p className="px-2.5 pb-1 pt-2 text-xs uppercase tracking-[.12em] text-slate-400">Загруженные</p>}
      {documents.map((item) => <div key={item.id} className="flex items-center gap-1">
        <button type="button" aria-current={view.doc?.id === item.id} className={`${menuItem} flex-1`} onClick={() => run(() => host.selectDoc(item.id))}>
          {view.doc?.id === item.id ? <Check size={16} className="shrink-0 text-[#9af4e7]" /> : <FileText size={16} className="shrink-0" />}
          <span className="min-w-0 flex-1 truncate">{item.name}</span>
          <span className="shrink-0 text-xs tabular-nums text-slate-400">{item.pageCount} стр.</span>
        </button>
        <Button type="button" variant="ghost" size="icon-sm" title={`Удалить «${item.name}»`} aria-label={`Удалить «${item.name}»`} className={headerButton} onClick={() => run(() => host.deleteDoc(item.id, item.name))}><Trash /></Button>
      </div>)}
      {view.doc && <button type="button" className={menuItem} onClick={() => run(host.closeDoc)}><X size={16} />Закрыть материал</button>}
    </PopoverContent>
  </Popover>;
}

type Props = {
  view: WorkspaceView;
  roomId: string;
  layer: WorkspaceLayerProps;
  drawing: PaneDrawing;
  highlight: boolean;
  orientation: Orientation;
  host: WorkspaceHostActions | null;
  upload: MaterialUpload | null;
  onActivate: (part: WorkspacePart) => void;
};

export function DocumentPane({ view, roomId, layer, drawing, highlight, orientation, host, upload, onActivate }: Props) {
  const doc = view.doc;
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const pick = () => fileInput.current?.click();
  const page = doc?.pages[doc.page];
  const dropProps = host ? {
    onDragOver(event: DragEvent) {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      setDragging(true);
    },
    onDragLeave(event: DragEvent) {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
    },
    onDrop(event: DragEvent) {
      event.preventDefault();
      setDragging(false);
      const file = event.dataTransfer.files[0];
      if (file && !upload) host.uploadFile(file);
    },
  } : undefined;
  const controls = <>
    {doc && <PageNav label="Стр." page={doc.page} count={doc.pageCount} onFlip={host ? (next) => host.flip("doc", next) : undefined} />}
    {host && <MaterialsMenu view={view} host={host} busy={Boolean(upload)} onPick={pick} />}
    {host && <CollapseButton part="doc" orientation={orientation} onClick={() => host.collapse("doc", true)} />}
  </>;
  return <PaneShell part="doc" title={doc?.name ?? "Материалы"} controls={controls} highlight={highlight} onActivate={onActivate} dropProps={dropProps}>
    {host && <input ref={fileInput} type="file" accept={ACCEPT} hidden onChange={(event) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (file) host.uploadFile(file);
    }} />}
    {doc && page ? <ZoomFrame frame={{ width: page[0], height: page[1] }} frameless zoomable interaction={drawing.interaction} fingersDraw={drawing.fingersDraw} resetKey={doc.surface} zoomLabel="Масштаб материала" frameClassName="bg-white" media={<PageImage roomId={roomId} doc={doc} />}>
      <AnnotationLayer key={doc.surface} {...layer} shareId={doc.surface} toolKey={drawing.toolKey} toolbar={drawing.active ? drawing.toolbar : undefined} hotkeysEnabled={drawing.active} label="Пометки на материале" />
    </ZoomFrame> : host && <div className="flex h-full flex-col items-center justify-center gap-3 overflow-y-auto p-6 text-center">
      <span className="grid size-12 shrink-0 place-items-center rounded-full bg-[#6de7d4]/15 text-[#9af4e7]"><Upload size={22} /></span>
      <p className="text-sm font-medium">Перетащите сюда PDF, PowerPoint, Word или картинку</p>
      <p className="max-w-xs text-xs leading-relaxed text-slate-400">До 100 страниц. Ученики видят ту же страницу, что и вы, и могут приближать её.</p>
      <Button type="button" disabled={Boolean(upload)} className="bg-[#6de7d4] text-[#10243a] hover:bg-[#96f5e7]" onClick={pick}>Выбрать файл</Button>
      {(view.documents?.length ?? 0) > 0 && <p className="text-xs text-slate-400">Или откройте загруженный в меню «Материалы»</p>}
    </div>}
    {upload && host && <UploadBanner upload={upload} onCancel={host.cancelUpload} />}
    {dragging && <div className="pointer-events-none absolute inset-2 z-40 grid place-items-center rounded-lg border-2 border-dashed border-[#6de7d4] bg-[#0e192c]/80 text-sm font-medium text-[#9af4e7]">Отпустите, чтобы загрузить</div>}
  </PaneShell>;
}
