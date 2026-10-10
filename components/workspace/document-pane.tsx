"use client";

import { useImperativeHandle, useMemo, useRef, useState, type DragEvent, type Ref } from "react";
import { Check, FileText, FolderOpen, LoaderCircle, Trash, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollStripView, SurfaceLayer, type StripApi } from "@/components/workspace/scroll-strip-view";
import { CollapseButton, headerButton, PageJump, PaneShell, type Orientation, type PaneApi, type PaneDrawing, type PaneEditing, type WorkspaceHostActions, type WorkspaceLayerProps, type WorkspacePart } from "@/components/workspace/pane-chrome";
import type { MaterialUpload } from "@/hooks/use-material-upload";
import { useFollowTarget, type WorkspaceFollow } from "@/hooks/use-workspace-view";
import { stepTile, stripLayout } from "@/lib/scroll-strip";
import { DOC_GAP, docSurface } from "@/lib/workspace";
import type { WorkspaceDoc, WorkspaceView } from "@/lib/confa-types";

const ACCEPT = ".pdf,.pptx,.ppt,.odp,.docx,.doc,.odt,.rtf,.png,.jpg,.jpeg,.webp,application/pdf,image/png,image/jpeg,image/webp";
const menuItem = "flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm outline-none hover:bg-white/10 focus-visible:bg-white/10 disabled:pointer-events-none disabled:opacity-40";

function pageUrl(roomId: string, doc: Pick<WorkspaceDoc, "id" | "token">, page: number): string {
  return `/api/rooms/${roomId}/documents/${doc.id}/pages/${page}?t=${encodeURIComponent(doc.token)}`;
}

// A page as a plain image (the signed link caches for a day). Only pages near the viewport are mounted, the rest are blank
// sheets with their number, so a long material never loads all at once.
function PageImage({ roomId, doc, page }: { roomId: string; doc: WorkspaceDoc; page: number }) {
  const src = pageUrl(roomId, doc, page);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  return <>
    {/* eslint-disable-next-line @next/next/no-img-element -- a signed, private page image */}
    <img key={src} src={src} alt="" draggable={false} decoding="async" onLoad={() => setLoaded(src)} onError={() => setFailed(src)} className="pointer-events-none absolute inset-0 h-full w-full select-none bg-white object-fill" />
    {loaded !== src && failed !== src && <BlankPage page={page} busy />}
    {failed === src && <div className="absolute inset-0 grid place-items-center bg-white p-4 text-center text-sm text-slate-500">Не удалось загрузить страницу</div>}
  </>;
}

function BlankPage({ page, busy = false }: { page: number; busy?: boolean }) {
  return <div className="absolute inset-0 grid place-items-center bg-white text-slate-300">
    {busy ? <LoaderCircle className="size-6 animate-spin text-slate-400" /> : <span className="text-2xl font-semibold tabular-nums">{page + 1}</span>}
  </div>;
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
  follow: WorkspaceFollow;
  highlight: boolean;
  orientation: Orientation;
  host: WorkspaceHostActions | null;
  upload: MaterialUpload | null;
  api?: Ref<PaneApi>;
  onActivate: (part: WorkspacePart) => void;
  onEditing: PaneEditing;
};

// The material: all its pages in one column that the teacher scrolls (wheel, drag, scrollbar, keys) or jumps through by page number.
export function DocumentPane({ view, roomId, layer, drawing, follow, highlight, orientation, host, upload, api, onActivate, onEditing }: Props) {
  const doc = view.doc;
  const fileInput = useRef<HTMLInputElement>(null);
  const strip = useRef<StripApi>(null);
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState({ doc: doc?.id ?? null, page: 0 }); // the page «3 / 12» names (lib/scroll-strip readingTile)
  const docId = doc?.id ?? null;
  const key = useMemo(() => ({ ws: view.id, docId }), [view.id, docId]);
  const target = useFollowTarget(follow, "doc", key, doc?.pos ?? 0, Boolean(host));
  const pick = () => fileInput.current?.click();
  const pages = doc?.pages;
  const layout = useMemo(() => stripLayout((pages ?? []).map(([width, height]) => width / height), DOC_GAP), [pages]);
  const widest = pages?.reduce((max, [width]) => Math.max(max, width), 0) ?? 0;
  const first = pages?.[0];
  const firstAspect = first ? first[0] / first[1] : 1;
  const page = reading.doc === doc?.id ? Math.min(reading.page, (doc?.pageCount ?? 1) - 1) : Math.floor(doc?.pos ?? 0);
  useImperativeHandle(api, () => ({ get strip() { return strip.current; }, current: () => page }), [page]);
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
    {doc && <PageJump page={page} count={doc.pageCount} onJump={host ? (next) => strip.current?.scrollTo(next, true) : undefined}
      onStep={host ? (by) => { if (strip.current) strip.current.scrollTo(stepTile(strip.current.position(), page, by, doc.pageCount), true); } : undefined} />}
    {host && <MaterialsMenu view={view} host={host} busy={Boolean(upload)} onPick={pick} />}
    {host && <CollapseButton part="doc" orientation={orientation} onClick={() => host.collapse("doc", true)} />}
  </>;
  return <PaneShell part="doc" title={doc?.name ?? "Материалы"} controls={controls} highlight={highlight} onActivate={onActivate} dropProps={dropProps}>
    {host && <input ref={fileInput} type="file" accept={ACCEPT} hidden onChange={(event) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (file) host.uploadFile(file);
    }} />}
    {doc && pages ? <ScrollStripView api={strip} layout={layout} pixelWidth={widest} resetKey={doc.id} fitAspect={firstAspect >= 1 ? firstAspect : null} host={Boolean(host)} start={doc.pos} target={target} onIntent={() => follow.touch("doc")} onView={(seen, settled) => follow.report("doc", key, seen, settled)}
      interaction={drawing.interaction} fingersDraw={drawing.fingersDraw} penOnly={drawing.penOnly} onPenOnlyChange={drawing.onPenOnlyChange} zoomLabel="Масштаб материала"
      onTile={(index) => setReading({ doc: doc.id, page: Math.max(0, index) })} scrollLabel={(position) => `Стр. ${Math.min(doc.pageCount, Math.floor(position) + 1)}`}
      placeholder={(index) => <BlankPage page={index} />}
      tile={(index, slot) => <>
        <PageImage roomId={roomId} doc={doc} page={index} />
        <SurfaceLayer hub={layer.hub} id={docSurface(doc.id, index)} slot={slot} selfId={layer.selfId} canDraw={layer.canDraw} canModerate={layer.canModerate} armedByDefault={layer.armedByDefault} coarse={layer.coarse} toolKey={drawing.toolKey} color={drawing.color} label={`Пометки на странице ${index + 1}`} onEditing={(style) => onEditing("doc", style)} />
      </>} /> : host && <div className="flex h-full flex-col items-center justify-center gap-3 overflow-y-auto p-6 text-center">
      <span className="grid size-12 shrink-0 place-items-center rounded-full bg-[#6de7d4]/15 text-[#9af4e7]"><Upload size={22} /></span>
      <p className="text-sm font-medium">Перетащите сюда PDF, PowerPoint, Word или картинку</p>
      <p className="max-w-xs text-xs leading-relaxed text-slate-400">До 100 страниц. Вы прокручиваете материал — ученики видят то же место и могут приближать его.</p>
      <Button type="button" disabled={Boolean(upload)} className="bg-[#6de7d4] text-[#10243a] hover:bg-[#96f5e7]" onClick={pick}>Выбрать файл</Button>
      {(view.documents?.length ?? 0) > 0 && <p className="text-xs text-slate-400">Или откройте загруженный в меню «Материалы»</p>}
    </div>}
    {upload && host && <UploadBanner upload={upload} onCancel={host.cancelUpload} />}
    {dragging && <div className="pointer-events-none absolute inset-2 z-40 grid place-items-center rounded-lg border-2 border-dashed border-[#6de7d4] bg-[#0e192c]/80 text-sm font-medium text-[#9af4e7]">Отпустите, чтобы загрузить</div>}
  </PaneShell>;
}
