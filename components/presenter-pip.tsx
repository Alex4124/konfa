"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { TrackReference } from "@livekit/components-react";
import { Eye, EyeOff, MonitorUp, PictureInPicture2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AnnotationLayer } from "@/components/annotations/annotation-layer";
import { SharedScreen } from "@/components/shared-screen";
import type { PresentationLayerProps } from "@/components/presentation-area";
import { useAnnotationPrefs, useArmedTool } from "@/hooks/use-annotation-prefs";
import { useBoard, type AnnotationSync } from "@/hooks/use-annotation-sync";
import { useMediaQuery } from "@/hooks/use-media-query";
import { defaultToolFor, toolbarLayoutFor } from "@/lib/annotation-tools";
import { marksCountLabel } from "@/lib/presenter-alerts";
import { stripPlacement } from "@/lib/view-transform";
import type { Size } from "@/lib/annotation-geometry";
import type { DisplaySurface } from "@/lib/presenter-pip";

export type PipNotice = { id: number; text: string };
type Props = {
  pipWindow: Window;
  shareId: string | null; // null while the room state does not (yet) name this member the share owner
  trackRef: TrackReference | undefined;
  surface: DisplaySurface | null;
  layer: PresentationLayerProps; // the same sync object and rights as the main layer
  notice: PipNotice | null; // sonner cannot portal into the PiP document: the newest notice shows in a status line
  onNotice: (text: string) => void;
};

const NOTICE_MS = 6000;
// Room the toolbar takes beside the frame: min-h-12 row with py-1, w-15 column.
const TOOLBAR_ROW_PX = 56;
const TOOLBAR_COLUMN_PX = 60;
const ROW_MARGIN = 8;
const EMPTY: Size = { width: 0, height: 0 };
const fade = "transition-opacity group-has-data-[annotating=true]/presentation:pointer-events-none group-has-data-[annotating=true]/presentation:opacity-30";

// The presenter's «Окно пометок поверх экрана»: the live share, everyone's marks, drafts and the laser, drawn in a Document PiP window.
// Same React tree as the room (portal), so no second LiveKit or sync subscription; everything inside resolves its window via ownerDocument.
export function PresenterPip({ pipWindow, shareId, trackRef, surface, layer, notice, onNotice }: Props) {
  const body = pipWindow.document.body;
  const coarse = useMediaQuery("(pointer: coarse)", pipWindow);
  const short = useMediaQuery("(max-height: 520px)", pipWindow);
  const monitor = surface === "monitor";
  const [videoFor, setVideoFor] = useState(surface);
  const [showVideo, setShowVideo] = useState(!monitor); // a whole-screen share would show an endless tunnel: marks only by default
  const [bannerHidden, setBannerHidden] = useState(false);
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null);
  const [area, setArea] = useState<Size>(EMPTY);
  const [aspect, setAspect] = useState(16 / 9);
  const [hiddenNotice, setHiddenNotice] = useState(() => notice?.id ?? null); // a notice from before the window opened is stale
  const areaRef = useRef<HTMLDivElement>(null);
  const [prefs] = useAnnotationPrefs();
  // Same store and fallback as the layer (the presenter is armed by default), so the frame takes the pointer exactly while a tool draws.
  const [uiTool] = useArmedTool(shareId ?? "", defaultToolFor({ armedByDefault: true, coarse, lastDrawTool: prefs.lastDrawTool }));
  const interaction = layer.canDraw && uiTool !== "view" ? "draw" : "view";
  const ready = Boolean(trackRef && shareId);
  const toolbarVisible = ready && Boolean(layer.canDraw);
  // Most PiP windows are short; the column is used only when it leaves the larger frame (a portrait share). Compact until measured.
  const columnBetter = area.width > 0 && area.height > 0 && stripPlacement(area, aspect, { top: TOOLBAR_ROW_PX, left: TOOLBAR_COLUMN_PX }) === "left";
  const layout = toolbarLayoutFor({ expanded: false, coarse, short: short && columnBetter, areaWidth: Math.max(1, area.width - ROW_MARGIN) });
  const column = layout.placement === "column";
  const hideVideo = monitor && !showVideo;
  const shownNotice = notice && notice.id !== hiddenNotice ? notice : null;

  if (videoFor !== surface) {
    setVideoFor(surface);
    setShowVideo(surface !== "monitor");
  }

  // The PiP window's own observer: the opener's would not deliver while the opener tab is hidden.
  useEffect(() => {
    const element = areaRef.current;
    const Observer = element?.ownerDocument.defaultView?.ResizeObserver;
    if (!element || !Observer) return;
    const observer = new Observer(([entry]) => {
      if (!entry) return;
      const width = Math.round(entry.contentRect.width), height = Math.round(entry.contentRect.height);
      setArea((current) => current.width === width && current.height === height ? current : { width, height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = pipWindow.setTimeout(() => setHiddenNotice(notice.id), NOTICE_MS);
    return () => pipWindow.clearTimeout(timer);
  }, [notice, pipWindow]);

  const videoLabel = showVideo ? "Скрыть видео" : "Показать видео";

  return createPortal(<div className="group/presentation flex h-dvh w-full flex-col overflow-hidden bg-[#0e192c] text-white">
    {monitor && !bannerHidden && <div className="flex shrink-0 items-start gap-2 border-b border-amber-300/20 bg-amber-400/15 py-1.5 pl-3 pr-1.5 text-xs leading-4 text-amber-100">
      <p className="min-w-0 flex-1">Окно видно участникам, пока оно на показываемом экране. Перетащите его на другой монитор или покажите отдельное окно.</p>
      <Button type="button" variant="secondary" size="xs" className="shrink-0 bg-[#2d415d] text-white hover:bg-[#3e5673]" onClick={() => setShowVideo(!showVideo)}>{showVideo ? <EyeOff /> : <Eye />}{videoLabel}</Button>
      <Button type="button" variant="ghost" size="icon-xs" title="Скрыть подсказку" aria-label="Скрыть подсказку" className="shrink-0 text-amber-100 hover:bg-white/10 hover:text-white" onClick={() => setBannerHidden(true)}><X /></Button>
    </div>}
    <div ref={areaRef} className={`relative flex min-h-0 min-w-0 flex-1 ${toolbarVisible && column ? "flex-row" : "flex-col"}`}>
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-black">
        {trackRef && shareId ? <SharedScreen trackRef={trackRef} frameless zoomable={false} interaction={interaction} hideVideo={hideVideo} resetKey={shareId} onFrameChange={setAspect}>
          {hideVideo && <span className="pointer-events-none absolute inset-0 grid place-items-center p-3 text-center text-xs text-slate-500">Видео скрыто — видны только пометки</span>}
          <AnnotationLayer key={shareId} {...layer} shareId={shareId} coarse={coarse} armedByDefault toolbar={{ container: toolbar, layout }} portalContainer={body} onNotice={onNotice} />
        </SharedScreen> : <p className="grid h-full place-items-center p-3 text-center text-sm text-slate-300">Подключаем показ…</p>}
        {monitor && bannerHidden && <Button type="button" variant="secondary" size="icon-sm" title={videoLabel} aria-label={videoLabel} className={`absolute bottom-2 right-2 z-30 bg-[#0e192c]/85 text-white shadow-xl hover:bg-[#243c5a] ${fade}`} onClick={() => setShowVideo(!showVideo)}>{showVideo ? <EyeOff /> : <Eye />}</Button>}
        <div role="status" aria-live="polite" className="pointer-events-none absolute inset-x-2 top-2 z-30 flex justify-center">{shownNotice && <span className="max-w-full rounded-lg border border-white/15 bg-[#1c2c45]/95 px-3 py-1.5 text-center text-xs text-white shadow-xl">{shownNotice.text}</span>}</div>
      </div>
      {toolbarVisible && <div ref={setToolbar} className={column ? "order-first flex w-15 shrink-0 flex-col items-center justify-center py-1" : "flex min-h-12 shrink-0 justify-center px-1 py-1"} />}
    </div>
  </div>, body);
}

type MirrorProps = {
  sync: AnnotationSync;
  shareId: string;
  selfId: string;
  pipSupported: boolean;
  pipOpen: boolean;
  onPip: () => void;
  onShow: () => void;
};

// Shown to a whole-screen presenter instead of their own share: drawing the share (and its marks) here would feed it back into the stream.
export function MirrorPlaceholder({ sync, shareId, selfId, pipSupported, pipOpen, onPip, onShow }: MirrorProps) {
  const board = useBoard(sync.store);
  const foreign = useMemo(() => board.shareId === shareId ? board.items.reduce((total, item) => item.authorId !== selfId ? total + 1 : total, 0) : 0, [board, shareId, selfId]);
  return <div className="grid h-full w-full place-items-center overflow-y-auto bg-[#0e192c] p-4 short:p-2">
    <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#17263e] p-5 text-center shadow-2xl short:p-3">
      <span className="mx-auto grid size-12 place-items-center rounded-full bg-[#6de7d4]/15 text-[#9af4e7] short:hidden"><MonitorUp size={22} /></span>
      <h2 className="mt-3 text-base font-semibold short:mt-0">Вы показываете весь экран</h2>
      <p className="mt-2 text-sm leading-relaxed text-slate-300">Демонстрация скрыта здесь, чтобы участники не видели эффект зеркала. {foreign ? `${marksCountLabel(foreign)} от участников.` : "Пометок от участников пока нет."}</p>
      <div className="mt-4 flex flex-wrap justify-center gap-2 short:mt-3">
        {pipSupported && <Button type="button" aria-pressed={pipOpen} className="bg-[#6de7d4] text-[#10243a] hover:bg-[#96f5e7]" onClick={onPip}><PictureInPicture2 />Окно пометок</Button>}
        <Button type="button" variant="secondary" className="bg-[#2d415d] text-white hover:bg-[#3e5673]" onClick={onShow}><Eye />Показать демонстрацию</Button>
      </div>
      <p className="mt-3 text-xs text-slate-400">Удобнее показывать отдельное окно или вкладку.</p>
    </div>
  </div>;
}
