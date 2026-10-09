"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { RoomAudioRenderer, useParticipants, useRoomContext, useTracks, VideoTrack } from "@livekit/components-react";
import { ConnectionState, LocalVideoTrack, RoomEvent, Track, type LocalTrackPublication, type RemoteParticipant } from "livekit-client";
import { Copy, Ellipsis, ExternalLink, EyeOff, Hand, MessageSquare, Mic, MicOff, MonitorUp, MonitorX, PhoneOff, PictureInPicture2, Radio, Smile, Users, Video, VideoOff, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Toaster } from "@/components/ui/sonner";
import { clusterButton, PresentationArea, type PresentationLayerProps } from "@/components/presentation-area";
import { MirrorPlaceholder, PresenterPip, type PipNotice } from "@/components/presenter-pip";
import { AuthorMarks, DepartedAuthors } from "@/components/annotations/author-marks";
import { BackgroundPicker, type VideoBackground } from "@/components/background-picker";
import { createStableBackgroundProcessor, type StableBackgroundProcessor } from "@/lib/stable-background";
import { accessLevel, accessRoomFromState, canAnnotate, canModerate, isShareOwner, type AccessMember } from "@/lib/annotation-permissions";
import { createStateRefresher, useAnnotationSync, windowTimers } from "@/hooks/use-annotation-sync";
import { resetArmedTool } from "@/hooks/use-annotation-prefs";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useVisualViewportReset } from "@/hooks/use-visual-viewport-reset";
import { useDocumentPip, useDocumentPipSupported } from "@/hooks/use-document-pip";
import { usePresenterAlerts } from "@/hooks/use-presenter-alerts";
import { pipFallbackSize, readAspectRatio, readDisplaySurface, type DisplaySurface } from "@/lib/presenter-pip";
import type { Role, RoomKind, RoomState } from "@/lib/confa-types";

type Joined = {
  member: { id: string; name: string; role: Role; canAnnotate: boolean };
  sessionToken: string; livekitToken: string; livekitUrl: string; guestUrl: string; kind: RoomKind;
};
type Props = { id: string; joined: Joined; initialCamera: boolean; background: VideoBackground | null; onBackgroundChange: (background: VideoBackground | null) => void; onLeave: () => void; onEnded: () => void; connectionError: string };

type FocusController = { setFocusBehavior: (behavior: "no-focus-change") => void };
type OwnShare = { shareId: string; surface: DisplaySurface };
type ApiError = Error & { status?: number; code?: string };
// Phones (portrait or landscape) start with the chat closed: it would cover the screen on join.
const PHONE_QUERY = "(max-width: 767px), (max-height: 520px)";
const railSize = "max-sm:size-9 short:size-9 tiny:size-8"; // 320 px phones: seven buttons fit the row or the rail
const moreItemClass = "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm outline-none hover:bg-white/10 focus-visible:bg-white/10 disabled:pointer-events-none disabled:opacity-40";
const chatEmoji = ["😀", "😄", "😂", "😊", "😍", "👍", "👏", "🎉", "❤️", "🙏", "🤔", "😮", "😢", "🔥", "👋", "✅", "🙌", "😎", "🤝", "💯"];

export function RoomView({ id, joined, initialCamera, background, onBackgroundChange, onLeave, onEnded, connectionError }: Props) {
  const room = useRoomContext();
  const participants = useParticipants();
  const cameras = useTracks([Track.Source.Camera]);
  const screens = useTracks([Track.Source.ScreenShare]);
  const [state, setState] = useState<RoomState | null>(null);
  const [error, setError] = useState("");
  const [panel, setPanel] = useState<"chat" | "people" | null>(() => typeof window !== "undefined" && window.matchMedia?.(PHONE_QUERY).matches ? null : "chat");
  const [moreOpen, setMoreOpen] = useState(false);
  const [expandedShareId, setExpandedShareId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [mic, setMic] = useState(room.localParticipant.isMicrophoneEnabled);
  const [cam, setCam] = useState(room.localParticipant.isCameraEnabled);
  const [cameraBusy, setCameraBusy] = useState(false);
  const [ownShare, setOwnShare] = useState<OwnShare | null>(null); // what this member last started sharing (whole screen or not)
  const [selfPreviewShareId, setSelfPreviewShareId] = useState<string | null>(null); // a whole-screen share the presenter chose to see anyway
  const [pipNotice, setPipNotice] = useState<PipNotice | null>(null);
  const chatEnd = useRef<HTMLDivElement>(null);
  const messageInput = useRef<HTMLInputElement>(null);
  const stoppingShare = useRef(false);
  const endedRef = useRef(false);
  const cameraStarting = useRef(false);
  const cameraProcessor = useRef<StableBackgroundProcessor | null>(null);
  const appliedBackgroundUrl = useRef<string | null>(null);
  const backgroundQueue = useRef<Promise<void>>(Promise.resolve());
  const backgroundRef = useRef(background);
  const previousBackground = useRef(background);
  const lastPermission = useRef<"on" | "off" | null>(null);
  useEffect(() => { backgroundRef.current = background; }, [background]);
  useVisualViewportReset();
  const activeIds = useMemo(() => new Set(participants.map((person) => person.identity)), [participants]);
  const self = state?.members.find((item) => item.id === joined.member.id);
  const role = self?.role || joined.member.role;
  const access = state ? accessRoomFromState(state.room) : null;
  const me: AccessMember = self ?? { id: joined.member.id, role, can_annotate: joined.member.canAnnotate };
  const canDraw = canAnnotate(me, access);
  const canModerateShare = canModerate(me, access);
  const permissionKey = access && role !== "host" ? (canAnnotate(me, { ...access, activeShareOwner: null }) ? "on" : "off") : null;
  const shareOwner = isShareOwner(me, access);
  const activeShareId = state?.room.activeShareId ?? null;
  const coarse = useMediaQuery("(pointer: coarse)");
  const isShort = useMediaQuery("(max-height: 520px)");
  const canPublish = role !== "viewer";
  const activeScreen = state?.room.activeShareId
    ? screens.find((track) => track.participant.identity === state.room.activeShareOwner)
    : undefined;
  const expanded = Boolean(activeScreen && state?.room.activeShareId === expandedShareId);
  const isSharing = screens.some((track) => track.participant.identity === joined.member.id);
  const myShareRequest = state?.shareRequests.find((item) => item.member_id === joined.member.id);
  const pendingShareRequests = state?.shareRequests.filter((item) => item.status === "pending") || [];
  const approvedShareRequest = state?.shareRequests.find((item) => item.status === "approved");
  const visibleMembers = state?.members.filter((person) => activeIds.has(person.id)) || [];
  const pipSupported = useDocumentPipSupported();
  const { pipWindow, open: openPipWindow, close: closePip } = useDocumentPip("Пометки — Конфа");
  const showPipNotice = (text: string) => setPipNotice((current) => ({ id: (current?.id ?? 0) + 1, text }));
  const ownSurface = ownShare && ownShare.shareId === activeShareId ? ownShare.surface : null;
  // A whole-screen presenter does not see their own share here: drawn on the shared screen it would loop back into the stream.
  const mirrorGuard = shareOwner && ownSurface === "monitor" && selfPreviewShareId !== activeShareId;

  const api = useCallback(async (path: string, body?: Record<string, unknown>, signal?: AbortSignal) => {
    const response = await fetch(`/api/rooms/${id}/${path}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${joined.sessionToken}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
    const result = await response.json() as Record<string, unknown>;
    if (!response.ok) throw Object.assign(new Error(typeof result.error === "string" ? result.error : "Не удалось выполнить действие"), { status: response.status, code: typeof result.code === "string" ? result.code : undefined }) as ApiError;
    return result;
  }, [id, joined.sessionToken]);

  const sync = useAnnotationSync({
    room, roomId: id, token: joined.sessionToken, self: { id: joined.member.id, name: joined.member.name }, state,
    requestRefresh: () => void refresh(),
    onNotice: (notice) => {
      toast(notice.text, { id: notice.code === "forbidden" ? "annotation-permission" : notice.code });
      if (pipWindow) showPipNotice(notice.text);
      if (notice.code === "forbidden") void refresh();
    },
  });
  // Marks live in the sync store; RoomView re-renders only when the rest of the state changes.
  const [refresher] = useState(() => {
    let stateKey = "";
    return createStateRefresher({
      fetchState: async (signal) => await api("state", undefined, signal) as unknown as RoomState,
      sync,
      onState: (next) => {
        const rest = { ...next, annotations: [] };
        const key = JSON.stringify(rest);
        if (key === stateKey) return;
        stateKey = key;
        setState(rest);
      },
      onError: (cause) => setError(cause instanceof Error ? cause.message : "Не удалось обновить комнату"),
      timers: windowTimers,
      now: () => performance.now(),
    });
  });
  const refresh = useCallback(() => refresher.run(), [refresher]);

  useEffect(() => {
    if (!state || state.room.status === "open" || endedRef.current) return;
    endedRef.current = true;
    room.disconnect();
    onEnded();
  }, [state, room, onEnded]);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [refresh]);

  useEffect(() => {
    if (!permissionKey) return;
    const previous = lastPermission.current;
    lastPermission.current = permissionKey;
    // A presenter keeps drawing on their own share whatever the switch says, so the toast would mislead them.
    if (!previous || previous === permissionKey || shareOwner) return;
    // Revoked or granted again: start over in the share's default tool (Просмотр for participants). External store write, no setState.
    if (activeShareId) resetArmedTool(activeShareId);
    toast.info(permissionKey === "on" ? "Ведущий разрешил вам рисовать на демонстрации" : "Ведущий отключил вам пометки", { id: "annotation-permission" });
  }, [permissionKey, shareOwner, activeShareId]);

  // Stopping the share (server state and track both agree) closes the PiP window; its pagehide then clears the hook state.
  useEffect(() => {
    if (pipWindow && !shareOwner && !isSharing) pipWindow.close();
  }, [pipWindow, shareOwner, isSharing]);

  usePresenterAlerts({ store: sync.store, selfId: joined.member.id, enabled: shareOwner, suppressed: Boolean(pipWindow) });

  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) setExpandedShareId(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [expanded]);

  useEffect(() => {
    // Only the server (no participant) may ask for a refresh; annotation ops are handled by useAnnotationSync.
    const onData = (payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
      if (topic !== "confa" || participant) return;
      try {
        if (JSON.parse(new TextDecoder().decode(payload))?.type === "state-changed") void refresh();
      } catch { /* Ignore malformed data */ }
    };
    room.on(RoomEvent.DataReceived, onData);
    return () => { room.off(RoomEvent.DataReceived, onData); };
  }, [room, refresh]);

  useEffect(() => { chatEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [state?.messages.length]);
  useEffect(() => {
    const syncMedia = () => {
      setMic(room.localParticipant.isMicrophoneEnabled);
      setCam(room.localParticipant.isCameraEnabled);
      if (!room.localParticipant.isCameraEnabled) { cameraProcessor.current = null; appliedBackgroundUrl.current = null; }
    };
    room.on(RoomEvent.LocalTrackPublished, syncMedia); room.on(RoomEvent.LocalTrackUnpublished, syncMedia);
    return () => { room.off(RoomEvent.LocalTrackPublished, syncMedia); room.off(RoomEvent.LocalTrackUnpublished, syncMedia); };
  }, [room]);

  async function action(path: string, body: Record<string, unknown>, loading = "") {
    setBusy(loading); setError("");
    try { const result = await api(path, body); await refresh(); return result; }
    catch (cause) {
      const failure = cause instanceof Error ? cause as ApiError : null;
      if (failure && path === "annotations" && (failure.code === "forbidden" || failure.status === 403)) { toast.info(failure.message, { id: "annotation-permission" }); void refresh(); }
      else setError(failure ? failure.message : "Ошибка");
      return null;
    }
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
          if (cameraProcessor.current) await cameraProcessor.current.switchBackground(selected.url);
          else {
            const processor = createStableBackgroundProcessor(selected.url, setError);
            await track.setProcessor(processor);
            cameraProcessor.current = processor;
          }
          appliedBackgroundUrl.current = selected.url;
        } else if (cameraProcessor.current) {
          await track.stopProcessor();
          cameraProcessor.current = null;
          appliedBackgroundUrl.current = null;
        }
      } catch (cause) {
        await track.stopProcessor().catch(() => {});
        cameraProcessor.current = null;
        appliedBackgroundUrl.current = null;
        setError(cause instanceof Error ? cause.message : "Не удалось применить фон");
      }
    });
    return backgroundQueue.current;
  }, [room]);

  const startCamera = useCallback(async () => {
    if (cameraStarting.current || room.localParticipant.isCameraEnabled) return;
    cameraStarting.current = true;
    setCameraBusy(true);
    let processor: StableBackgroundProcessor | null = null;
    try {
      const selected = backgroundRef.current;
      if (selected) {
        try { processor = createStableBackgroundProcessor(selected.url, setError); }
        catch (cause) { setError(cause instanceof Error ? cause.message : "Обработка фона недоступна"); }
      }
      try { await room.localParticipant.setCameraEnabled(true, processor ? { processor } : undefined); }
      catch (cause) {
        if (!processor) throw cause;
        await processor.destroy().catch(() => {});
        processor = null;
        setError(cause instanceof Error ? cause.message : "Обработка фона недоступна");
        await room.localParticipant.setCameraEnabled(true);
      }
      cameraProcessor.current = processor;
      appliedBackgroundUrl.current = processor ? selected?.url || null : null;
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
    toast.dismiss("presenter-share");
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
    if (role !== "host" && myShareRequest?.status !== "approved") {
      setError("Сначала дождитесь разрешения ведущего");
      return;
    }
    if (state?.room.activeShareOwner && state.room.activeShareOwner !== joined.member.id) {
      setError("Другой участник уже показывает экран");
      return;
    }
    setBusy("share"); setError("");
    let createdTracks: Awaited<ReturnType<typeof room.localParticipant.createScreenTracks>> = [];
    let reserved = false;
    try {
      {
        const Controller = (window as Window & { CaptureController?: new () => FocusController }).CaptureController;
        let controller: FocusController | undefined;
        // Stay on this tab after picking (Chrome/Edge): hosts run the room from here, and a presenter opens the PiP window here with one more click.
        if ((role === "host" || pipSupported) && Controller && "setFocusBehavior" in Controller.prototype) {
          try {
            controller = new Controller();
            controller.setFocusBehavior("no-focus-change");
          } catch { controller = undefined; }
        }
        // surfaceSwitching: Chrome's «Поделиться этой вкладкой» swaps the source without a new share, so the marks stay.
        createdTracks = await room.localParticipant.createScreenTracks({ selfBrowserSurface: "exclude", surfaceSwitching: "include", controller });
      }
      const video = createdTracks.find((track) => track.kind === Track.Kind.Video)?.mediaStreamTrack;
      const surface = readDisplaySurface(video);
      const ratio = readAspectRatio(video);
      const started = await api("share", { action: "start", ...(role === "host" ? {} : { requestId: myShareRequest?.id }) });
      reserved = true;
      if (typeof started.shareId === "string") setOwnShare({ shareId: started.shareId, surface });
      for (const track of createdTracks) await room.localParticipant.publishTrack(track);
      await refresh();
      announceShare(surface, ratio);
    } catch (cause) {
      stoppingShare.current = true;
      await room.localParticipant.setScreenShareEnabled(false).catch(() => {});
      createdTracks.forEach((track) => track.stop());
      if (reserved) await api("share", { action: "stop" }).catch(() => {});
      stoppingShare.current = false;
      await refresh();
      setError(cause instanceof Error ? cause.message : "Не удалось показать экран");
    } finally { setBusy(""); }
  }

  // The toast action is a click: requestWindow gets its user activation.
  function announceShare(surface: DisplaySurface, ratio: number) {
    if (pipSupported) toast("Вы показываете экран", { id: "presenter-share", duration: 20000, description: "Откройте окно пометок — оно будет поверх других окон, и вы увидите пометки участников.", action: { label: "Открыть окно пометок", onClick: () => openPipWindow(pipFallbackSize(ratio, surface === "monitor")) } });
    else toast("Вы показываете экран", { id: "presenter-share", duration: 10000, description: "Пометки участников видны на этой вкладке; их число появится в заголовке вкладки." });
  }

  function openPip() {
    toast.dismiss("presenter-share");
    openPipWindow(pipFallbackSize(readAspectRatio(activeScreen?.publication.track?.mediaStreamTrack), ownSurface === "monitor"));
  }

  function togglePip() {
    if (pipWindow) closePip();
    else openPip();
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

  function insertEmoji(emoji: string) {
    const input = messageInput.current;
    const start = input?.selectionStart ?? message.length;
    const end = input?.selectionEnd ?? start;
    if (message.length - (end - start) + emoji.length > 1000) return;
    setMessage(message.slice(0, start) + emoji + message.slice(end));
    setEmojiOpen(false);
    window.requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(start + emoji.length, start + emoji.length);
    });
  }
  function toggleRecording() {
    void action("recording", { action: recordingStatus === "recording" ? "stop" : "start" }, "recording");
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

  function annotationNote(person: RoomState["members"][number]) {
    if (person.role === "host") return "";
    const level = accessLevel(person, access);
    return level === "allowed" || level === "presenter" ? " · может рисовать" : level === "paused" ? " · пометки на паузе" : "";
  }

  function renderParticipantList() {
    return <>
      {role === "host" && state && <Button variant="secondary" size="sm" disabled={busy === "annotationAccess"} className="mb-3 w-full bg-[#2d415d] text-white hover:bg-[#3e5673]" title={state.room.annotationsEnabled ? "Выключить — рисовать смогут только ведущий и докладчик" : "Включить пометки для участников с разрешением"} onClick={() => void action("annotations", { action: "setAccess", enabled: !state.room.annotationsEnabled }, "annotationAccess")}>Пометки участников: {state.room.annotationsEnabled ? "включены" : "выключены"}</Button>}
      {role === "host" && approvedShareRequest && <div className="mb-3 rounded-xl border border-[#6de7d4]/30 bg-[#6de7d4]/10 p-3 text-sm">
        <p>Показ разрешён: {approvedShareRequest.name}</p>
        <Button size="sm" variant="secondary" disabled={busy === "shareRequest"} className="mt-2" onClick={() => void action("share-requests", { action: "revoke", requestId: approvedShareRequest.id }, "shareRequest")}>Отозвать разрешение</Button>
      </div>}
      {role === "host" && pendingShareRequests.length > 0 && <div className="mb-4 space-y-2 rounded-xl border border-[#6de7d4]/30 bg-[#6de7d4]/10 p-3">
        <p className="text-sm font-semibold text-[#9af4e7]">Запросы на показ экрана</p>
        {pendingShareRequests.map((shareRequest) => <div key={shareRequest.id} className="rounded-lg bg-[#20344e] p-2">
          <p className="truncate text-sm">{shareRequest.name}</p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" disabled={busy === "shareRequest" || Boolean(state?.room.activeShareId) || Boolean(approvedShareRequest)} onClick={() => void action("share-requests", { action: "approve", requestId: shareRequest.id }, "shareRequest")}>Разрешить</Button>
            <Button size="sm" variant="secondary" disabled={busy === "shareRequest"} onClick={() => void action("share-requests", { action: "deny", requestId: shareRequest.id }, "shareRequest")}>Отклонить</Button>
          </div>
        </div>)}
      </div>}
      <p className="px-2 pb-2 text-xs uppercase tracking-[.12em] text-slate-400">В комнате · {visibleMembers.length}</p>
      {visibleMembers.map((person) => <div key={person.id} className="mb-2 rounded-xl bg-[#20344e] p-3">
        <div className="flex items-center gap-2"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[#6de7d4]/20 text-sm font-semibold text-[#9af4e7]">{person.name.charAt(0).toUpperCase()}</span><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{person.name}{person.id === joined.member.id ? " (вы)" : ""}</p><p className="text-xs text-slate-400">{person.role === "host" ? "Ведущий" : person.role === "speaker" ? "Выступающий" : "Зритель"}{person.raised_hand ? " · поднял руку" : ""}{annotationNote(person)}</p></div>{activeShareId && <AuthorMarks sync={sync} shareId={activeShareId} authorId={person.id} canModerate={canModerateShare} />}</div>
        {role === "host" && person.id !== joined.member.id && <div className="mt-3 flex flex-wrap gap-1.5">
          {joined.kind === "webinar" && <Button size="xs" variant="secondary" onClick={() => void action(`members/${person.id}`, { action: "role", role: person.role === "viewer" ? "speaker" : "viewer" })}>{person.role === "viewer" ? "На сцену" : "В зрители"}</Button>}
          <Button size="xs" variant="secondary" onClick={() => void action(`members/${person.id}`, { action: "annotation", enabled: !person.can_annotate })}>{person.can_annotate ? "Запретить пометки" : "Разрешить пометки"}</Button>
          <Button size="xs" variant="secondary" onClick={() => void action(`members/${person.id}`, { action: "mute" })}>Выключить звук</Button>
          <Button size="xs" variant="destructive" onClick={() => { if (confirm(`Удалить участника ${person.name}?`)) void action(`members/${person.id}`, { action: "remove" }); }}>Удалить</Button>
        </div>}
      </div>)}
      {activeShareId && <DepartedAuthors sync={sync} shareId={activeShareId} presentIds={new Set(visibleMembers.map((person) => person.id))} canModerate={canModerateShare} />}
    </>;
  }

  function expandScreen() {
    if (!activeScreen || !state?.room.activeShareId) return;
    setExpandedShareId(state.room.activeShareId);
  }

  const recordingStatus = state?.recording?.status;
  const shareStatus = role !== "host" && ["pending", "approved", "denied"].includes(myShareRequest?.status || "") ? myShareRequest?.status === "pending" ? "Ждём ведущего" : myShareRequest?.status === "approved" ? "Показ разрешён" : "Ведущий отклонил" : null;
  // «Ещё» gathers what the footer hides on narrow phones; in landscape (header hidden) also the guest link and «Закончить конференцию».
  const moreInPortrait = canPublish || Boolean(state?.recording?.url); // hosts publish too
  const layerProps: PresentationLayerProps = { sync, selfId: joined.member.id, canDraw, canModerate: canModerateShare, armedByDefault: role === "host" || shareOwner, coarse };
  const shareActions = shareOwner ? <>
    {ownSurface === "monitor" && !mirrorGuard && <Button variant="secondary" size="icon-lg" title="Скрыть демонстрацию" aria-label="Скрыть демонстрацию" className={clusterButton} onClick={() => setSelfPreviewShareId(null)}><EyeOff /></Button>}
    {pipSupported && <Button variant="secondary" size="icon-lg" title="Окно пометок поверх экрана" aria-label="Окно пометок поверх экрана" aria-pressed={Boolean(pipWindow)} className={`${clusterButton} ${pipWindow ? "!bg-[#317b75]" : ""}`} onClick={togglePip}><PictureInPicture2 /></Button>}
  </> : null;

  return <main className={`relative flex h-dvh touch-manipulation flex-col overflow-hidden bg-[#0e192c] text-white short:flex-row ${expanded ? "min-h-0" : "roomy:min-h-[540px]"}`}>
    <RoomAudioRenderer />
    <Toaster theme="dark" position="top-center" />
    {pipWindow && <PresenterPip key={shareOwner ? activeShareId : null} pipWindow={pipWindow} shareId={shareOwner ? activeShareId : null} trackRef={shareOwner ? activeScreen : undefined} surface={ownSurface} layer={layerProps} notice={pipNotice} onNotice={showPipNotice} />}
    {!expanded && <header className="flex min-h-12 shrink-0 items-center justify-between gap-2 border-b border-white/10 px-3 pb-1.5 pt-[max(0.375rem,env(safe-area-inset-top))] sm:min-h-16 sm:gap-3 sm:px-6 short:hidden">
      <div className="flex min-w-0 items-center gap-3"><span className="brand-mark !h-9 !w-9 shrink-0 !rounded-xl"><Video size={19} /></span><div className="min-w-0"><h1 className="truncate text-base font-semibold">{joined.kind === "webinar" ? "Вебинар" : "Встреча"}</h1><p className="truncate text-xs text-slate-400">{visibleMembers.length} из 50 участников</p></div></div>
      <div className="flex shrink-0 items-center justify-end gap-2">
        {recordingStatus === "recording" && <span title="Идёт запись" className="flex items-center gap-2 rounded-full bg-rose-500/15 px-2.5 py-1.5 text-xs font-medium text-rose-200 sm:px-3"><span className="h-2 w-2 animate-pulse rounded-full bg-rose-400" /><span className="hidden sm:inline">Идёт запись</span></span>}
        {recordingStatus === "processing" && <span title="Готовим запись" className="flex items-center gap-2 rounded-full bg-amber-400/15 px-2.5 py-1.5 text-xs text-amber-200 sm:px-3"><span className="h-2 w-2 rounded-full bg-amber-300 sm:hidden" /><span className="hidden sm:inline">Готовим запись</span></span>}
        <Button variant="outline" size="sm" title="Ссылка для гостей" aria-label="Ссылка для гостей" className="border-white/20 bg-white/5 text-white hover:bg-white/10 hover:text-white" onClick={() => void copyGuestLink()}><Copy size={15} /><span className="hidden sm:inline">Ссылка для гостей</span></Button>
        {role === "host" && <Button variant="destructive" size="sm" title="Закончить конференцию" aria-label="Закончить конференцию" disabled={busy === "end"} className="rounded-xl" onClick={() => void endConference()}><PhoneOff size={16} /><span className="hidden sm:inline">Закончить конференцию</span></Button>}
      </div>
    </header>}

    {(error || connectionError) && <div role="alert" className={`flex items-center justify-between gap-3 bg-rose-500/90 px-5 py-2 text-sm text-white ${expanded ? "absolute left-1/2 top-14 z-50 w-[min(90vw,560px)] -translate-x-1/2 rounded-xl shadow-2xl" : "short:absolute short:left-1/2 short:top-2 short:z-50 short:w-[min(90vw,560px)] short:-translate-x-1/2 short:rounded-xl short:shadow-2xl"}`}><span>{connectionError || error}</span><button aria-label="Закрыть сообщение" onClick={() => setError("")}><X size={16} /></button></div>}

    <div className="relative flex min-h-0 min-w-0 flex-1">
      <section className={`isolate flex min-w-0 flex-1 flex-col ${activeScreen ? "" : "p-3 sm:p-5"}`}>
        {activeScreen && state ? <PresentationArea state={state} activeScreen={activeScreen} members={visibleMembers} expanded={expanded} onExpand={expandScreen} onCollapse={() => setExpandedShareId(null)} renderTile={renderParticipantTile} renderParticipantList={renderParticipantList} layerProps={layerProps} toolbarVisible={canDraw} actions={shareActions} placeholder={mirrorGuard && activeShareId ? <MirrorPlaceholder sync={sync} shareId={activeShareId} selfId={joined.member.id} pipSupported={pipSupported} pipOpen={Boolean(pipWindow)} onPip={togglePip} onShow={() => setSelfPreviewShareId(activeShareId)} /> : undefined} /> : <div className="grid min-h-0 flex-1 auto-rows-[minmax(140px,1fr)] grid-cols-[repeat(auto-fit,minmax(min(100%,180px),1fr))] gap-2 overflow-y-auto">
          {visibleMembers.map((person) => renderParticipantTile(person, "grid"))}
        </div>}
      </section>

      {!expanded && panel && <aside className="z-20 flex w-[min(360px,100%)] shrink-0 flex-col border-l border-white/10 bg-[#17263e] max-md:absolute max-md:inset-y-0 max-md:right-0 max-md:shadow-2xl short:absolute short:inset-y-0 short:right-0 short:w-[min(340px,100%)] short:shadow-2xl">
        <Tabs value={panel} onValueChange={(value) => setPanel(value as "chat" | "people")} className="flex h-full min-h-0 flex-col gap-0">
          <div className="flex items-center justify-between border-b border-white/10 px-4 py-3"><TabsList className="bg-[#283a54]"><TabsTrigger value="chat">Чат</TabsTrigger><TabsTrigger value="people">Участники</TabsTrigger></TabsList><Button variant="ghost" size="icon" aria-label="Закрыть панель" className="text-slate-300 hover:bg-white/10 hover:text-white" onClick={() => setPanel(null)}><X /></Button></div>
          <TabsContent value="chat" className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">{state?.messages.length ? state.messages.map((item) => <div key={item.id} className="space-y-1"><div className="flex items-baseline justify-between gap-2"><strong className="text-sm text-[#9af4e7]">{item.name}</strong><span className="text-xs text-slate-500">{new Date(item.created_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</span></div><p className="break-words text-sm leading-relaxed text-slate-100">{item.body}</p></div>) : <p className="pt-8 text-center text-sm text-slate-400">Сообщений пока нет</p>}<div ref={chatEnd} /></div>
            <form onSubmit={(event) => void sendMessage(event)} className="flex gap-2 border-t border-white/10 p-3">
              <input ref={messageInput} aria-label="Сообщение" maxLength={1000} enterKeyHint="send" value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Написать сообщение…" className="h-10 min-w-0 flex-1 rounded-lg border border-white/15 bg-[#213650] px-3 text-base outline-none focus:border-[#6de7d4] md:text-sm pointer-coarse:text-base" />
              <Popover open={emojiOpen} onOpenChange={setEmojiOpen}>
                <PopoverTrigger asChild><Button type="button" variant="secondary" size="icon" title="Добавить смайлик" aria-label="Добавить смайлик" className="shrink-0 bg-[#2d415d] text-white hover:bg-[#3e5673]"><Smile size={19} /></Button></PopoverTrigger>
                <PopoverContent align="end" side="top" className="grid w-60 grid-cols-5 gap-1 border-white/15 bg-[#1c2c45] p-2">
                  {chatEmoji.map((emoji) => <button key={emoji} type="button" className="grid h-9 w-9 place-items-center rounded-md text-xl hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-[#6de7d4]" aria-label={`Вставить ${emoji}`} onClick={() => insertEmoji(emoji)}>{emoji}</button>)}
                </PopoverContent>
              </Popover>
              <Button type="submit" disabled={!message.trim() || busy === "message"} className="bg-[#6de7d4] text-[#10243a] hover:bg-[#96f5e7]">Отправить</Button>
            </form>
          </TabsContent>
          <TabsContent value="people" className="min-h-0 flex-1 overflow-y-auto p-3">
            {renderParticipantList()}
          </TabsContent>
        </Tabs>
      </aside>}
    </div>

    {!expanded && <footer className="flex min-h-14 shrink-0 items-center justify-between gap-2 border-t border-white/10 bg-[#15243a] px-2 pb-[env(safe-area-inset-bottom)] sm:min-h-[72px] sm:px-6 short:min-h-0 short:w-16 short:flex-col short:justify-start short:gap-1 short:border-l short:border-t-0 short:px-1 short:pt-2 short:pb-[max(0.5rem,env(safe-area-inset-bottom))]">
      <div className="hidden min-w-0 sm:block short:hidden"><p className="truncate text-sm font-medium">{joined.member.name}</p><p className="text-xs text-slate-400">{role === "host" ? "Ведущий" : role === "speaker" ? "Выступающий" : "Зритель"}</p></div>
      {recordingStatus === "recording" && <span title="Идёт запись" className="hidden size-2.5 shrink-0 animate-pulse rounded-full bg-rose-400 short:block" />}
      <div className="flex min-w-0 flex-1 items-center justify-start gap-1 overflow-x-auto sm:justify-center sm:gap-2 short:min-h-0 short:w-full short:flex-col short:justify-start short:gap-1 short:overflow-x-hidden short:overflow-y-auto">
        {canPublish && <>
          <Button variant="secondary" size="icon-lg" title={mic ? "Выключить микрофон" : "Включить микрофон"} aria-label={mic ? "Выключить микрофон" : "Включить микрофон"} className={`rounded-full bg-[#2d415d] text-white hover:bg-[#3e5673] ${railSize}`} onClick={() => void toggleMic()}>{mic ? <Mic /> : <MicOff />}</Button>
          <Button variant="secondary" size="icon-lg" title={cam ? "Выключить камеру" : "Включить камеру"} aria-label={cam ? "Выключить камеру" : "Включить камеру"} disabled={cameraBusy} className={`rounded-full bg-[#2d415d] text-white hover:bg-[#3e5673] ${railSize}`} onClick={() => void toggleCam()}>{cam ? <Video /> : <VideoOff />}</Button>
          <div className="max-sm:hidden short:hidden"><BackgroundPicker background={background} onChange={onBackgroundChange} onError={setError} compact /></div>
          <Button variant="secondary" size="icon-lg" title={isSharing ? "Остановить демонстрацию" : role === "host" || myShareRequest?.status === "approved" ? "Показать экран" : myShareRequest?.status === "pending" ? "Отменить запрос на показ" : myShareRequest?.status === "active" ? "Подключаем показ" : "Запросить показ экрана"} aria-label={isSharing ? "Остановить демонстрацию" : role === "host" || myShareRequest?.status === "approved" ? "Показать экран" : myShareRequest?.status === "pending" ? "Отменить запрос на показ" : myShareRequest?.status === "active" ? "Подключаем показ" : "Запросить показ экрана"} disabled={busy === "share" || busy === "shareRequest" || (role !== "host" && myShareRequest?.status === "active" && !isSharing)} className={`rounded-full text-white hover:bg-[#3e5673] ${railSize} ${isSharing || myShareRequest?.status === "approved" ? "bg-[#317b75]" : "bg-[#2d415d]"}`} onClick={() => {
            if (isSharing || role === "host" || myShareRequest?.status === "approved") void toggleShare();
            else if (myShareRequest?.status === "pending") void action("share-requests", { action: "cancel", requestId: myShareRequest.id }, "shareRequest");
            else void action("share-requests", { action: "request" }, "shareRequest");
          }}>{isSharing ? <MonitorX /> : <MonitorUp />}</Button>
          {shareStatus && <span className="max-w-28 shrink-0 text-xs text-slate-200 max-sm:hidden short:hidden">{shareStatus}</span>}
        </>}
        <Button variant="secondary" size="icon-lg" title="Поднять или опустить руку" aria-label="Поднять или опустить руку" className={`rounded-full text-white hover:bg-[#3e5673] ${railSize} ${self?.raised_hand ? "bg-amber-500/40" : "bg-[#2d415d]"}`} onClick={() => void action("hand", {})}><Hand /></Button>
        <Button variant="secondary" size="icon-lg" title="Чат" aria-label="Чат" aria-pressed={panel === "chat"} className={`rounded-full bg-[#2d415d] text-white hover:bg-[#3e5673] ${railSize}`} onClick={() => setPanel(panel === "chat" ? null : "chat")}><MessageSquare /></Button>
        <Button variant="secondary" size="icon-lg" title={pendingShareRequests.length ? `Участники, запросов на показ: ${pendingShareRequests.length}` : "Участники"} aria-label={pendingShareRequests.length ? `Участники, запросов на показ: ${pendingShareRequests.length}` : "Участники"} aria-pressed={panel === "people"} className={`relative rounded-full bg-[#2d415d] text-white hover:bg-[#3e5673] ${railSize}`} onClick={() => setPanel(panel === "people" ? null : "people")}><Users />{role === "host" && pendingShareRequests.length > 0 && <span className="absolute -right-1 -top-1 grid h-5 min-w-5 place-items-center rounded-full bg-[#6de7d4] px-1 text-[11px] font-bold text-[#10243a]">{pendingShareRequests.length}</span>}</Button>
        {role === "host" && <Button variant="secondary" size="icon-lg" title={recordingStatus === "recording" ? "Остановить запись" : "Начать запись"} aria-label={recordingStatus === "recording" ? "Остановить запись" : "Начать запись"} disabled={busy === "recording" || recordingStatus === "processing"} className={`rounded-full text-white hover:bg-[#3e5673] max-sm:hidden short:hidden ${recordingStatus === "recording" ? "bg-rose-500/40" : "bg-[#2d415d]"}`} onClick={toggleRecording}><Radio /></Button>}
        <Popover open={moreOpen} onOpenChange={setMoreOpen}>
          <PopoverTrigger asChild><Button variant="secondary" size="icon-lg" title="Ещё" aria-label="Ещё" className={`rounded-full bg-[#2d415d] text-white hover:bg-[#3e5673] ${railSize} ${moreInPortrait ? "sm:hidden" : "hidden"} short:inline-flex`}><Ellipsis /></Button></PopoverTrigger>
          <PopoverContent side={isShort ? "left" : "top"} align="end" collisionPadding={8} className="w-64 border-white/15 bg-[#1c2c45] p-1.5 text-white">
            {canPublish && <div className="px-1.5 py-1"><BackgroundPicker background={background} onChange={onBackgroundChange} onError={setError} /></div>}
            {shareStatus && <p className="px-3 py-1.5 text-xs text-slate-300">{shareStatus}</p>}
            {role === "host" && <button type="button" disabled={busy === "recording" || recordingStatus === "processing"} className={moreItemClass} onClick={() => { setMoreOpen(false); toggleRecording(); }}><Radio size={16} />{recordingStatus === "recording" ? "Остановить запись" : recordingStatus === "processing" ? "Готовим запись" : "Начать запись"}</button>}
            {state?.recording?.url && <a href={state.recording.url} target="_blank" rel="noreferrer" className={moreItemClass} onClick={() => setMoreOpen(false)}><ExternalLink size={16} />Открыть запись</a>}
            <button type="button" className={`${moreItemClass} hidden short:flex`} onClick={() => { setMoreOpen(false); void copyGuestLink(); }}><Copy size={16} />Ссылка для гостей</button>
            {role === "host" && <button type="button" disabled={busy === "end"} className={`${moreItemClass} hidden text-rose-200 short:flex`} onClick={() => { setMoreOpen(false); void endConference(); }}><PhoneOff size={16} />Закончить конференцию</button>}
          </PopoverContent>
        </Popover>
      </div>
      <div className="flex items-center gap-2 short:flex-col">
        {state?.recording?.url && <a href={state.recording.url} target="_blank" rel="noreferrer" className="hidden text-xs text-[#9af4e7] underline sm:inline short:hidden">Открыть запись</a>}
        {role !== "host" && <Button variant="destructive" size="sm" title="Выйти" aria-label="Выйти" className={`rounded-xl ${railSize}`} onClick={() => { room.disconnect(); onLeave(); }}><PhoneOff size={16} /><span className="hidden sm:inline short:hidden">Выйти</span></Button>}
      </div>
    </footer>}
  </main>;
}
