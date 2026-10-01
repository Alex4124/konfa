"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { RoomAudioRenderer, useParticipants, useRoomContext, useTracks, VideoTrack } from "@livekit/components-react";
import { BackgroundProcessor, supportsBackgroundProcessors, type BackgroundProcessorWrapper } from "@livekit/track-processors";
import { ConnectionState, LocalVideoTrack, RoomEvent, Track, type LocalTrackPublication } from "livekit-client";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Copy, Hand, LayoutGrid, List, Maximize2, MessageSquare, Mic, MicOff, Minimize2, MonitorUp, MonitorX, PhoneOff, Radio, Users, Video, VideoOff, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AnnotationLayer } from "@/components/annotation-layer";
import { SharedScreen } from "@/components/shared-screen";
import { BackgroundPicker, type VideoBackground } from "@/components/background-picker";
import type { AnnotationPayload, Role, RoomKind, RoomState, Tool } from "@/lib/confa-types";

type Joined = {
  member: { id: string; name: string; role: Role; canAnnotate: boolean };
  sessionToken: string; livekitToken: string; livekitUrl: string; guestUrl: string; kind: RoomKind;
};
type Props = { id: string; joined: Joined; initialCamera: boolean; background: VideoBackground | null; onBackgroundChange: (background: VideoBackground | null) => void; onLeave: () => void; onEnded: () => void; connectionError: string };

type FocusController = { setFocusBehavior: (behavior: "no-focus-change") => void };

export function RoomView({ id, joined, initialCamera, background, onBackgroundChange, onLeave, onEnded, connectionError }: Props) {
  const room = useRoomContext();
  const participants = useParticipants();
  const cameras = useTracks([Track.Source.Camera]);
  const screens = useTracks([Track.Source.ScreenShare]);
  const [state, setState] = useState<RoomState | null>(null);
  const [error, setError] = useState("");
  const [panel, setPanel] = useState<"chat" | "people" | null>("chat");
  const [expandedShareId, setExpandedShareId] = useState<string | null>(null);
  const [overlayView, setOverlayView] = useState<"tiles" | "list">("tiles");
  const [overlayCollapsed, setOverlayCollapsed] = useState(false);
  const [overlayNavigation, setOverlayNavigation] = useState({ overflow: false, canPrevious: false, canNext: false });
  const [participantsOnTop, setParticipantsOnTop] = useState(true);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const [drafts, setDrafts] = useState<Array<{ id: string; shareId: string; kind: Tool; payload: AnnotationPayload }>>([]);
  const [mic, setMic] = useState(room.localParticipant.isMicrophoneEnabled);
  const [cam, setCam] = useState(room.localParticipant.isCameraEnabled);
  const [cameraBusy, setCameraBusy] = useState(false);
  const [toolbarContainer, setToolbarContainer] = useState<HTMLDivElement | null>(null);
  const presentationRef = useRef<HTMLDivElement>(null);
  const overlayNavigationRef = useRef<HTMLDivElement>(null);
  const overlayTilesRef = useRef<HTMLDivElement>(null);
  const chatEnd = useRef<HTMLDivElement>(null);
  const stoppingShare = useRef(false);
  const endedRef = useRef(false);
  const cameraStarting = useRef(false);
  const cameraProcessor = useRef<BackgroundProcessorWrapper | null>(null);
  const appliedBackgroundUrl = useRef<string | null>(null);
  const backgroundQueue = useRef<Promise<void>>(Promise.resolve());
  const backgroundRef = useRef(background);
  const previousBackground = useRef(background);
  useEffect(() => { backgroundRef.current = background; }, [background]);
  const activeIds = useMemo(() => new Set(participants.map((person) => person.identity)), [participants]);
  const self = state?.members.find((item) => item.id === joined.member.id);
  const role = self?.role || joined.member.role;
  const canDraw = role === "host" || (Boolean(state?.room.annotationsEnabled) && Boolean(self?.can_annotate));
  const canPublish = role !== "viewer";
  const activeScreen = state?.room.activeShareId
    ? screens.find((track) => track.participant.identity === state.room.activeShareOwner)
    : undefined;
  const hasActiveScreen = Boolean(activeScreen);
  const expanded = Boolean(activeScreen && state?.room.activeShareId === expandedShareId);
  const isSharing = screens.some((track) => track.participant.identity === joined.member.id);
  const visibleMembers = state?.members.filter((person) => activeIds.has(person.id)) || [];
  const overlayMemberIds = visibleMembers.map((person) => person.id).join("\u0000");
  const visibleDrafts = drafts.filter((item) => {
    if (item.shareId !== state?.room.activeShareId) return false;
    const author = state?.members.find((member) => member.id === item.id);
    return author?.role === "host" || (Boolean(state?.room.annotationsEnabled) && Boolean(author?.can_annotate));
  });

  const api = useCallback(async (path: string, body?: Record<string, unknown>) => {
    const response = await fetch(`/api/rooms/${id}/${path}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${joined.sessionToken}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const result = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "Не удалось выполнить действие");
    return result;
  }, [id, joined.sessionToken]);

  const refresh = useCallback(async () => {
    try {
      const next = await api("state") as unknown as RoomState;
      setState(next);
      if (next.room.status !== "open" && !endedRef.current) {
        endedRef.current = true;
        room.disconnect();
        onEnded();
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось обновить комнату"); }
  }, [api, room, onEnded]);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [refresh]);

  useEffect(() => {
    const element = presentationRef.current;
    if (!hasActiveScreen || !element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setParticipantsOnTop(entry.contentRect.width >= entry.contentRect.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasActiveScreen, expanded]);

  const updateOverlayNavigation = useCallback(() => {
    const viewport = overlayTilesRef.current;
    if (!viewport) return;
    const position = participantsOnTop ? viewport.scrollLeft : viewport.scrollTop;
    const end = participantsOnTop ? viewport.scrollWidth - viewport.clientWidth : viewport.scrollHeight - viewport.clientHeight;
    const navigationHeight = participantsOnTop ? 0 : (overlayNavigationRef.current?.offsetHeight ?? 0);
    const overflow = end > navigationHeight + 1;
    const next = { overflow, canPrevious: overflow && position > 1, canNext: overflow && position < end - 1 };
    setOverlayNavigation((current) => current.overflow === next.overflow && current.canPrevious === next.canPrevious && current.canNext === next.canNext ? current : next);
  }, [participantsOnTop]);

  useEffect(() => {
    const viewport = overlayTilesRef.current;
    if (!expanded || overlayCollapsed || overlayView !== "tiles" || !viewport) return;
    viewport.scrollLeft = 0;
    viewport.scrollTop = 0;
    let frame = 0;
    const scheduleUpdate = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(updateOverlayNavigation);
    };
    const observer = new ResizeObserver(scheduleUpdate);
    observer.observe(viewport);
    scheduleUpdate();
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [expanded, overlayCollapsed, overlayView, participantsOnTop, overlayMemberIds, updateOverlayNavigation]);

  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpandedShareId(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [expanded]);

  useEffect(() => {
    const onData = (payload: Uint8Array, participant?: { identity: string }, _kind?: unknown, topic?: string) => {
      try {
        const data = JSON.parse(new TextDecoder().decode(payload));
        if (topic === "confa" && data.type === "state-changed") void refresh();
        if (topic === "confa-annotation-draft" && participant && data.shareId === state?.room.activeShareId) {
          const source = state?.members.find((member) => member.id === participant.identity);
          if (!source || (source.role !== "host" && (!state?.room.annotationsEnabled || !source.can_annotate))) return;
          setDrafts((current) => {
            const rest = current.filter((item) => item.id !== participant.identity);
            return data.payload && Array.isArray(data.payload.points) ? [...rest, { id: participant.identity, shareId: data.shareId, kind: data.kind, payload: data.payload }] : rest;
          });
        }
      } catch { /* Ignore malformed data */ }
    };
    room.on(RoomEvent.DataReceived, onData);
    return () => { room.off(RoomEvent.DataReceived, onData); };
  }, [room, refresh, state]);

  useEffect(() => { chatEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [state?.messages.length]);
  useEffect(() => {
    const sync = () => {
      setMic(room.localParticipant.isMicrophoneEnabled);
      setCam(room.localParticipant.isCameraEnabled);
      if (!room.localParticipant.isCameraEnabled) { cameraProcessor.current = null; appliedBackgroundUrl.current = null; }
    };
    room.on(RoomEvent.LocalTrackPublished, sync); room.on(RoomEvent.LocalTrackUnpublished, sync);
    return () => { room.off(RoomEvent.LocalTrackPublished, sync); room.off(RoomEvent.LocalTrackUnpublished, sync); };
  }, [room]);

  async function action(path: string, body: Record<string, unknown>, loading = "") {
    setBusy(loading); setError("");
    try { const result = await api(path, body); await refresh(); return result; }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Ошибка"); return null; }
    finally { setBusy(""); }
  }

  async function toggleMic() {
    try { await room.localParticipant.setMicrophoneEnabled(!mic); setMic(!mic); }
    catch { setError("Нет доступа к микрофону"); }
  }
  const applyCurrentBackground = useCallback(() => {
    backgroundQueue.current = backgroundQueue.current.catch(() => {}).then(async () => {
      const track = room.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
      if (!(track instanceof LocalVideoTrack)) return;
      const selected = backgroundRef.current;
      if (selected?.url === appliedBackgroundUrl.current) return;
      try {
        if (selected) {
          if (!supportsBackgroundProcessors()) throw new Error("Этот браузер не поддерживает замену фона");
          if (cameraProcessor.current) await cameraProcessor.current.switchTo({ mode: "virtual-background", imagePath: selected.url });
          else {
            const processor = BackgroundProcessor({ mode: "virtual-background", imagePath: selected.url });
            await track.setProcessor(processor);
            cameraProcessor.current = processor;
          }
          appliedBackgroundUrl.current = selected.url;
        } else if (cameraProcessor.current) {
          await track.stopProcessor();
          cameraProcessor.current = null;
          appliedBackgroundUrl.current = null;
        }
      } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось применить фон"); }
    });
    return backgroundQueue.current;
  }, [room]);

  const startCamera = useCallback(async () => {
    if (cameraStarting.current || room.localParticipant.isCameraEnabled) return;
    cameraStarting.current = true;
    setCameraBusy(true);
    let processor: BackgroundProcessorWrapper | null = null;
    try {
      const selected = backgroundRef.current;
      if (selected) {
        if (!supportsBackgroundProcessors()) throw new Error("Этот браузер не поддерживает замену фона");
        processor = BackgroundProcessor({ mode: "virtual-background", imagePath: selected.url });
      }
      await room.localParticipant.setCameraEnabled(true, processor ? { processor } : undefined);
      cameraProcessor.current = processor;
      appliedBackgroundUrl.current = selected?.url || null;
      setCam(true);
      if (backgroundRef.current?.url !== selected?.url) await applyCurrentBackground();
    } catch (cause) {
      if (processor) void processor.destroy();
      setError(cause instanceof Error ? cause.message : "Нет доступа к камере");
    } finally {
      cameraStarting.current = false;
      setCameraBusy(false);
    }
  }, [room, applyCurrentBackground]);

  useEffect(() => {
    if (!initialCamera || !canPublish) return;
    const connected = () => { void startCamera(); };
    if (room.state === ConnectionState.Connected) connected();
    else room.on(RoomEvent.Connected, connected);
    return () => { room.off(RoomEvent.Connected, connected); };
  }, [room, initialCamera, canPublish, startCamera]);

  useEffect(() => {
    if (previousBackground.current?.url === background?.url) return;
    previousBackground.current = background;
    void applyCurrentBackground();
  }, [background, applyCurrentBackground]);

  async function toggleCam() {
    if (!cam) { await startCamera(); return; }
    setCameraBusy(true);
    try {
      await room.localParticipant.setCameraEnabled(false);
      cameraProcessor.current = null;
      appliedBackgroundUrl.current = null;
      setCam(false);
    } catch { setError("Не удалось выключить камеру"); }
    finally { setCameraBusy(false); }
  }

  const stopShare = useCallback(async () => {
    if (stoppingShare.current) return;
    stoppingShare.current = true;
    setBusy("share");
    try {
      await room.localParticipant.setScreenShareEnabled(false);
      if (!endedRef.current) await api("share", { action: "stop" });
      if (!endedRef.current) await refresh();
    } catch (cause) { if (!endedRef.current) setError(cause instanceof Error ? cause.message : "Не удалось остановить демонстрацию"); }
    finally {
      stoppingShare.current = false;
      setBusy("");
    }
  }, [room, api, refresh]);

  async function toggleShare() {
    if (isSharing) { await stopShare(); return; }
    if (state?.room.activeShareOwner && state.room.activeShareOwner !== joined.member.id) {
      setError("Другой участник уже показывает экран");
      return;
    }
    setBusy("share"); setError("");
    let createdTracks: Awaited<ReturnType<typeof room.localParticipant.createScreenTracks>> = [];
    try {
      if (role === "host") {
        const Controller = (window as Window & { CaptureController?: new () => FocusController }).CaptureController;
        let controller: FocusController | undefined;
        if (Controller && "setFocusBehavior" in Controller.prototype) {
          try {
            controller = new Controller();
            controller.setFocusBehavior("no-focus-change");
          } catch { controller = undefined; }
        }
        createdTracks = await room.localParticipant.createScreenTracks({ selfBrowserSurface: "exclude", controller });
        for (const track of createdTracks) await room.localParticipant.publishTrack(track);
      } else {
        await room.localParticipant.setScreenShareEnabled(true);
      }
      await api("share", { action: "start" });
      await refresh();
    } catch (cause) {
      await room.localParticipant.setScreenShareEnabled(false).catch(() => {});
      createdTracks.forEach((track) => track.stop());
      setError(cause instanceof Error ? cause.message : "Не удалось показать экран");
    } finally { setBusy(""); }
  }

  useEffect(() => {
    const unpublished = (publication: LocalTrackPublication) => {
      if (publication.source === Track.Source.ScreenShare && !stoppingShare.current && !endedRef.current) void stopShare();
    };
    room.on(RoomEvent.LocalTrackUnpublished, unpublished);
    return () => { room.off(RoomEvent.LocalTrackUnpublished, unpublished); };
  }, [room, stopShare]);

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    const body = message.trim();
    if (!body) return;
    const result = await action("message", { body }, "message");
    if (result) setMessage("");
  }
  function sendDraft(kind: Tool, payload: AnnotationPayload | null) {
    if (!state?.room.activeShareId || !canDraw) return;
    const data = new TextEncoder().encode(JSON.stringify({ shareId: state.room.activeShareId, kind, payload }));
    void room.localParticipant.publishData(data, { reliable: false, topic: "confa-annotation-draft" }).catch(() => {});
  }
  async function addAnnotation(kind: Tool, payload: AnnotationPayload) {
    return Boolean(await action("annotations", { action: "add", kind, payload }));
  }
  async function moveAnnotation(targetId: string, dx: number, dy: number) {
    return Boolean(await action("annotations", { action: "move", targetId, dx, dy }));
  }
  async function annotationAction(name: "undo" | "clear" | "erase", targetId?: string) {
    await action("annotations", { action: name, targetId });
  }
  async function copyGuestLink() {
    try { await navigator.clipboard.writeText(joined.guestUrl); }
    catch { setError("Не удалось скопировать ссылку"); }
  }

  async function endConference() {
    if (!window.confirm("Закончить конференцию для всех участников?")) return;
    setBusy("end"); setError("");
    try {
      await api("end", {});
      endedRef.current = true;
      room.disconnect();
      onEnded();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось закончить конференцию"); }
    finally { setBusy(""); }
  }

  function renderParticipantTile(person: RoomState["members"][number], layout: "grid" | "top" | "left") {
    const video = cameras.find((track) => track.participant.identity === person.id);
    const size = layout === "grid" ? "min-h-0" : layout === "top" ? "h-full aspect-video shrink-0" : "w-full aspect-video shrink-0";
    return <div key={person.id} className={`relative min-w-0 overflow-hidden rounded-xl bg-[#213650] ${size}`}>
      {video ? <VideoTrack trackRef={video} className="h-full w-full object-cover" /> : <div className="grid h-full place-items-center"><span className="grid h-12 w-12 place-items-center rounded-full bg-[#6de7d4]/20 text-lg font-semibold text-[#9af4e7]">{person.name.charAt(0).toUpperCase()}</span></div>}
      <span className={`absolute left-2 max-w-[calc(100%-16px)] truncate rounded bg-[#0b1728]/70 text-xs ${layout === "grid" ? "bottom-2 px-2 py-1" : "bottom-1 px-1.5 py-0.5"}`}>{person.name}{person.id === joined.member.id ? " (вы)" : ""}{person.raised_hand ? " ✋" : ""}</span>
    </div>;
  }

  function renderParticipantList() {
    return <>
      {role === "host" && state && <Button variant="secondary" size="sm" disabled={busy === "annotationAccess"} className="mb-3 w-full bg-[#2d415d] text-white hover:bg-[#3e5673]" onClick={() => void action("annotations", { action: "setAccess", enabled: !state.room.annotationsEnabled }, "annotationAccess")}>Пометки: {state.room.annotationsEnabled ? "все" : "только ведущий"}</Button>}
      <p className="px-2 pb-2 text-xs uppercase tracking-[.12em] text-slate-400">В комнате · {visibleMembers.length}</p>
      {visibleMembers.map((person) => <div key={person.id} className="mb-2 rounded-xl bg-[#20344e] p-3">
        <div className="flex items-center gap-2"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[#6de7d4]/20 text-sm font-semibold text-[#9af4e7]">{person.name.charAt(0).toUpperCase()}</span><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{person.name}{person.id === joined.member.id ? " (вы)" : ""}</p><p className="text-xs text-slate-400">{person.role === "host" ? "Ведущий" : person.role === "speaker" ? "Выступающий" : "Зритель"}{person.raised_hand ? " · поднял руку" : ""}</p></div></div>
        {role === "host" && person.id !== joined.member.id && <div className="mt-3 flex flex-wrap gap-1.5">
          {joined.kind === "webinar" && <Button size="xs" variant="secondary" onClick={() => void action(`members/${person.id}`, { action: "role", role: person.role === "viewer" ? "speaker" : "viewer" })}>{person.role === "viewer" ? "На сцену" : "В зрители"}</Button>}
          <Button size="xs" variant="secondary" disabled={!state?.room.annotationsEnabled} onClick={() => void action(`members/${person.id}`, { action: "annotation", enabled: !person.can_annotate })}>{person.can_annotate ? "Запретить пометки" : "Разрешить пометки"}</Button>
          <Button size="xs" variant="secondary" onClick={() => void action(`members/${person.id}`, { action: "mute" })}>Выключить звук</Button>
          <Button size="xs" variant="destructive" onClick={() => { if (confirm(`Удалить участника ${person.name}?`)) void action(`members/${person.id}`, { action: "remove" }); }}>Удалить</Button>
        </div>}
      </div>)}
    </>;
  }

  function expandScreen() {
    if (!activeScreen || !state?.room.activeShareId) return;
    setOverlayView("tiles");
    setOverlayCollapsed(false);
    setExpandedShareId(state.room.activeShareId);
  }

  function pageOverlay(direction: -1 | 1) {
    const viewport = overlayTilesRef.current;
    if (!viewport) return;
    const tiles = Array.from(viewport.children) as HTMLElement[];
    if (tiles.length < 2) return;
    const horizontal = participantsOnTop;
    const first = tiles[0];
    const step = horizontal ? tiles[1].offsetLeft - first.offsetLeft : tiles[1].offsetTop - first.offsetTop;
    if (step <= 0) return;
    const style = window.getComputedStyle(viewport);
    const padding = horizontal
      ? parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
      : parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const tileSize = horizontal ? first.offsetWidth : first.offsetHeight;
    const viewportSize = (horizontal ? viewport.clientWidth : viewport.clientHeight) - padding;
    const pageSize = Math.max(1, Math.floor((viewportSize + step - tileSize + 0.5) / step));
    const lastStart = Math.max(0, tiles.length - pageSize);
    const pageStarts = Array.from({ length: Math.ceil(tiles.length / pageSize) }, (_, page) => Math.min(page * pageSize, lastStart))
      .filter((start, index, starts) => index === 0 || start !== starts[index - 1]);
    const maxScroll = horizontal ? viewport.scrollWidth - viewport.clientWidth : viewport.scrollHeight - viewport.clientHeight;
    const offset = (index: number) => Math.min(maxScroll, horizontal ? tiles[index].offsetLeft - first.offsetLeft : tiles[index].offsetTop - first.offsetTop);
    const position = horizontal ? viewport.scrollLeft : viewport.scrollTop;
    const currentPage = pageStarts.reduce((nearest, start, index) => Math.abs(offset(start) - position) < Math.abs(offset(pageStarts[nearest]) - position) ? index : nearest, 0);
    const targetPage = Math.max(0, Math.min(pageStarts.length - 1, currentPage + direction));
    const target = offset(pageStarts[targetPage]);
    viewport.scrollTo(horizontal ? { left: target, behavior: "auto" } : { top: target, behavior: "auto" });
    updateOverlayNavigation();
  }

  const recordingStatus = state?.recording?.status;

  return <main className={`relative flex h-dvh flex-col overflow-hidden bg-[#0e192c] text-white ${expanded ? "min-h-0" : "min-h-[540px]"}`}>
    <RoomAudioRenderer />
    {!expanded && <header className="flex min-h-16 flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-2 sm:px-6">
      <div className="flex min-w-0 items-center gap-3"><span className="brand-mark !h-9 !w-9 !rounded-xl"><Video size={19} /></span><div className="min-w-0"><h1 className="truncate text-base font-semibold">{joined.kind === "webinar" ? "Вебинар" : "Встреча"}</h1><p className="text-xs text-slate-400">{visibleMembers.length} из 50 участников</p></div></div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {recordingStatus === "recording" && <span className="flex items-center gap-2 rounded-full bg-rose-500/15 px-3 py-1.5 text-xs font-medium text-rose-200"><span className="h-2 w-2 animate-pulse rounded-full bg-rose-400" /> Идёт запись</span>}
        {recordingStatus === "processing" && <span className="rounded-full bg-amber-400/15 px-3 py-1.5 text-xs text-amber-200">Готовим запись</span>}
        <Button variant="outline" size="sm" className="border-white/20 bg-white/5 text-white hover:bg-white/10 hover:text-white" onClick={() => void copyGuestLink()}><Copy size={15} /><span className="hidden sm:inline">Ссылка для гостей</span></Button>
        {role === "host" && <Button variant="destructive" size="sm" disabled={busy === "end"} className="rounded-xl" onClick={() => void endConference()}><PhoneOff size={16} />Закончить конференцию</Button>}
      </div>
    </header>}

    {(error || connectionError) && <div role="alert" className={`flex items-center justify-between gap-3 bg-rose-500/90 px-5 py-2 text-sm text-white ${expanded ? "absolute left-1/2 top-14 z-50 w-[min(90vw,560px)] -translate-x-1/2 rounded-xl shadow-2xl" : ""}`}><span>{connectionError || error}</span><button aria-label="Закрыть сообщение" onClick={() => setError("")}><X size={16} /></button></div>}

    <div className="flex min-h-0 flex-1">
      <section className={`flex min-w-0 flex-1 flex-col ${activeScreen ? "" : "p-3 sm:p-5"}`}>
        {activeScreen ? <div ref={presentationRef} className={`relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-[#0e192c] ${participantsOnTop ? "flex-col" : "flex-row"}`}>
          {!expanded && <div aria-label="Видео участников" className={participantsOnTop
            ? "flex h-[clamp(88px,12vh,136px)] shrink-0 gap-2 overflow-x-auto px-2 py-1"
            : "flex w-[clamp(100px,15vw,176px)] shrink-0 flex-col gap-2 overflow-y-auto px-1 py-2"}>
            {visibleMembers.map((person) => renderParticipantTile(person, participantsOnTop ? "top" : "left"))}
          </div>}

          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="relative min-h-0 flex-1 overflow-hidden bg-black">
              <SharedScreen trackRef={activeScreen} frameless>
                {state?.room.activeShareId && <AnnotationLayer key={state.room.activeShareId} annotations={state.annotations} canDraw={canDraw} canClear={role === "host"} memberId={joined.member.id} onAdd={addAnnotation} onMove={moveAnnotation} onAction={annotationAction} onDraft={sendDraft} drafts={visibleDrafts} toolbarContainer={toolbarContainer} />}
              </SharedScreen>
              {!expanded && <span className="absolute left-3 top-3 rounded-lg bg-[#0e192c]/80 px-3 py-1.5 text-xs text-white">{activeScreen.participant.name || "Демонстрация экрана"}</span>}
            </div>
            {canDraw && <div ref={setToolbarContainer} className={expanded
              ? "absolute bottom-3 left-1/2 z-40 flex max-w-[calc(100%-24px)] -translate-x-1/2 justify-center"
              : "flex min-h-10 shrink-0 justify-center"} />}
          </div>

          <Button variant="secondary" size="icon-lg" title={expanded ? "Свернуть экран" : "Развернуть экран"} aria-label={expanded ? "Свернуть экран" : "Развернуть экран"} className="absolute right-3 top-3 z-40 bg-[#0e192c]/85 text-white shadow-xl hover:bg-[#243c5a]" onClick={() => expanded ? setExpandedShareId(null) : expandScreen()}>{expanded ? <Minimize2 /> : <Maximize2 />}</Button>

          {expanded && <div className={`absolute z-30 flex min-h-0 flex-col overflow-hidden rounded-xl border border-white/15 bg-[#14243a]/90 shadow-2xl backdrop-blur-md ${participantsOnTop
            ? overlayCollapsed ? "left-3 top-3" : overlayView === "tiles" ? "left-3 top-3 w-fit max-w-[calc(100%-76px)] max-h-[min(50vh,440px)]" : "left-3 top-3 max-h-[min(50vh,440px)] w-[min(360px,75vw)]"
            : overlayCollapsed ? "left-3 top-3" : overlayView === "tiles" ? "left-3 top-3 h-fit max-h-[calc(100%-24px)] w-[clamp(110px,16vw,180px)]" : "bottom-3 left-3 top-3 w-[min(340px,75vw)]"}`}>
            <div className="flex shrink-0 items-center justify-between gap-1 p-1.5">
              {overlayCollapsed ? <Button variant="ghost" size="sm" aria-label="Развернуть панель участников" aria-expanded={false} className="text-white hover:bg-white/10 hover:text-white" onClick={() => setOverlayCollapsed(false)}><Users size={16} />{visibleMembers.length}{participantsOnTop ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</Button> : <>
                <span className="min-w-0 truncate px-1 text-xs text-slate-200">{visibleMembers.length}</span>
                <div className="flex items-center gap-0.5">
                  <Button variant={overlayView === "tiles" ? "secondary" : "ghost"} size="icon-xs" title="Видео участников" aria-label="Видео участников" aria-pressed={overlayView === "tiles"} className="text-white hover:bg-white/10 hover:text-white" onClick={() => setOverlayView("tiles")}><LayoutGrid size={15} /></Button>
                  <Button variant={overlayView === "list" ? "secondary" : "ghost"} size="icon-xs" title="Список участников" aria-label="Список участников" aria-pressed={overlayView === "list"} className="text-white hover:bg-white/10 hover:text-white" onClick={() => setOverlayView("list")}><List size={15} /></Button>
                  <Button variant="ghost" size="icon-xs" title="Свернуть панель участников" aria-label="Свернуть панель участников" aria-expanded={true} className="text-white hover:bg-white/10 hover:text-white" onClick={() => setOverlayCollapsed(true)}>{participantsOnTop ? <ChevronUp size={15} /> : <ChevronLeft size={15} />}</Button>
                </div>
              </>}
            </div>
            {!overlayCollapsed && (overlayView === "tiles"
              ? <>
                {overlayNavigation.overflow && <div ref={overlayNavigationRef} className="flex shrink-0 items-center justify-center gap-1 px-1 pb-1">
                  <Button variant="ghost" size="icon-xs" title="Предыдущие участники" aria-label="Предыдущие участники" disabled={!overlayNavigation.canPrevious} className="text-white hover:bg-white/10 hover:text-white" onClick={() => pageOverlay(-1)}>{participantsOnTop ? <ChevronLeft size={15} /> : <ChevronUp size={15} />}</Button>
                  <Button variant="ghost" size="icon-xs" title="Следующие участники" aria-label="Следующие участники" disabled={!overlayNavigation.canNext} className="text-white hover:bg-white/10 hover:text-white" onClick={() => pageOverlay(1)}>{participantsOnTop ? <ChevronRight size={15} /> : <ChevronDown size={15} />}</Button>
                </div>}
                <div ref={overlayTilesRef} aria-label="Видео участников" onScroll={updateOverlayNavigation} className={participantsOnTop
                  ? "flex h-[clamp(84px,13vh,120px)] w-max max-w-full min-w-0 gap-2 overflow-x-auto p-2"
                  : "flex min-h-0 flex-col gap-2 overflow-y-auto p-2"}>
                  {visibleMembers.map((person) => renderParticipantTile(person, participantsOnTop ? "top" : "left"))}
                </div>
              </>
              : <div aria-label="Список участников" className="min-h-0 flex-1 overflow-y-auto p-3">{renderParticipantList()}</div>)}
          </div>}
        </div> : <div className="grid min-h-0 flex-1 auto-rows-[minmax(140px,1fr)] grid-cols-[repeat(auto-fit,minmax(min(100%,180px),1fr))] gap-2 overflow-y-auto">
          {visibleMembers.map((person) => renderParticipantTile(person, "grid"))}
        </div>}
      </section>

      {!expanded && panel && <aside className="z-10 flex w-[min(360px,100vw)] shrink-0 flex-col border-l border-white/10 bg-[#17263e] max-md:absolute max-md:bottom-[72px] max-md:right-0 max-md:top-16 max-md:shadow-2xl">
        <Tabs value={panel} onValueChange={(value) => setPanel(value as "chat" | "people")} className="flex h-full min-h-0 flex-col gap-0">
          <div className="flex items-center justify-between border-b border-white/10 px-4 py-3"><TabsList className="bg-[#283a54]"><TabsTrigger value="chat">Чат</TabsTrigger><TabsTrigger value="people">Участники</TabsTrigger></TabsList><Button variant="ghost" size="icon" aria-label="Закрыть панель" className="text-slate-300 hover:bg-white/10 hover:text-white" onClick={() => setPanel(null)}><X /></Button></div>
          <TabsContent value="chat" className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">{state?.messages.length ? state.messages.map((item) => <div key={item.id} className="space-y-1"><div className="flex items-baseline justify-between gap-2"><strong className="text-sm text-[#9af4e7]">{item.name}</strong><span className="text-xs text-slate-500">{new Date(item.created_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</span></div><p className="break-words text-sm leading-relaxed text-slate-100">{item.body}</p></div>) : <p className="pt-8 text-center text-sm text-slate-400">Сообщений пока нет</p>}<div ref={chatEnd} /></div>
            <form onSubmit={(event) => void sendMessage(event)} className="flex gap-2 border-t border-white/10 p-3"><input aria-label="Сообщение" maxLength={1000} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Написать сообщение…" className="h-10 min-w-0 flex-1 rounded-lg border border-white/15 bg-[#213650] px-3 text-sm outline-none focus:border-[#6de7d4]" /><Button type="submit" disabled={!message.trim() || busy === "message"} className="bg-[#6de7d4] text-[#10243a] hover:bg-[#96f5e7]">Отправить</Button></form>
          </TabsContent>
          <TabsContent value="people" className="min-h-0 flex-1 overflow-y-auto p-3">
            {renderParticipantList()}
          </TabsContent>
        </Tabs>
      </aside>}
    </div>

    {!expanded && <footer className="flex min-h-[72px] items-center justify-between gap-2 border-t border-white/10 bg-[#15243a] px-3 sm:px-6">
      <div className="hidden min-w-0 sm:block"><p className="truncate text-sm font-medium">{joined.member.name}</p><p className="text-xs text-slate-400">{role === "host" ? "Ведущий" : role === "speaker" ? "Выступающий" : "Зритель"}</p></div>
      <div className="flex min-w-0 flex-1 items-center justify-start gap-1.5 overflow-x-auto sm:justify-center sm:gap-2">
        {canPublish && <>
          <Button variant="secondary" size="icon-lg" title={mic ? "Выключить микрофон" : "Включить микрофон"} aria-label={mic ? "Выключить микрофон" : "Включить микрофон"} className="rounded-full bg-[#2d415d] text-white hover:bg-[#3e5673]" onClick={() => void toggleMic()}>{mic ? <Mic /> : <MicOff />}</Button>
          <Button variant="secondary" size="icon-lg" title={cam ? "Выключить камеру" : "Включить камеру"} aria-label={cam ? "Выключить камеру" : "Включить камеру"} disabled={cameraBusy} className="rounded-full bg-[#2d415d] text-white hover:bg-[#3e5673]" onClick={() => void toggleCam()}>{cam ? <Video /> : <VideoOff />}</Button>
          <BackgroundPicker background={background} onChange={onBackgroundChange} onError={setError} compact />
          <Button variant="secondary" size="icon-lg" title={isSharing ? "Остановить демонстрацию" : "Показать экран"} aria-label={isSharing ? "Остановить демонстрацию" : "Показать экран"} disabled={busy === "share"} className={`rounded-full text-white hover:bg-[#3e5673] ${isSharing ? "bg-[#317b75]" : "bg-[#2d415d]"}`} onClick={() => void toggleShare()}>{isSharing ? <MonitorX /> : <MonitorUp />}</Button>
        </>}
        <Button variant="secondary" size="icon-lg" title="Поднять или опустить руку" aria-label="Поднять или опустить руку" className={`rounded-full text-white hover:bg-[#3e5673] ${self?.raised_hand ? "bg-amber-500/40" : "bg-[#2d415d]"}`} onClick={() => void action("hand", {})}><Hand /></Button>
        <Button variant="secondary" size="icon-lg" title="Чат" aria-label="Чат" className="rounded-full bg-[#2d415d] text-white hover:bg-[#3e5673]" onClick={() => setPanel(panel === "chat" ? null : "chat")}><MessageSquare /></Button>
        <Button variant="secondary" size="icon-lg" title="Участники" aria-label="Участники" className="rounded-full bg-[#2d415d] text-white hover:bg-[#3e5673]" onClick={() => setPanel(panel === "people" ? null : "people")}><Users /></Button>
        {role === "host" && <Button variant="secondary" size="icon-lg" title={recordingStatus === "recording" ? "Остановить запись" : "Начать запись"} aria-label={recordingStatus === "recording" ? "Остановить запись" : "Начать запись"} disabled={busy === "recording" || recordingStatus === "processing"} className={`rounded-full text-white hover:bg-[#3e5673] ${recordingStatus === "recording" ? "bg-rose-500/40" : "bg-[#2d415d]"}`} onClick={() => void action("recording", { action: recordingStatus === "recording" ? "stop" : "start" }, "recording")}><Radio /></Button>}
      </div>
      <div className="flex items-center gap-2">
        {state?.recording?.url && <a href={state.recording.url} target="_blank" rel="noreferrer" className="hidden text-xs text-[#9af4e7] underline sm:inline">Открыть запись</a>}
        {role !== "host" && <Button variant="destructive" size="sm" className="rounded-xl" onClick={() => { room.disconnect(); onLeave(); }}><PhoneOff size={16} /><span className="hidden sm:inline">Выйти</span></Button>}
      </div>
    </footer>}
  </main>;
}
