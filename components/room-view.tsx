"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { RoomAudioRenderer, useParticipants, useRoomContext, useTracks, VideoTrack } from "@livekit/components-react";
import { RoomEvent, Track } from "livekit-client";
import { Copy, Hand, MessageSquare, Mic, MicOff, MonitorUp, MonitorX, PhoneOff, Radio, Users, Video, VideoOff, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AnnotationLayer } from "@/components/annotation-layer";
import { SharedScreen } from "@/components/shared-screen";
import type { AnnotationPayload, Role, RoomKind, RoomState, Tool } from "@/lib/confa-types";

type Joined = {
  member: { id: string; name: string; role: Role; canAnnotate: boolean };
  sessionToken: string; livekitToken: string; livekitUrl: string; guestUrl: string; kind: RoomKind;
};
type Props = { id: string; joined: Joined; onLeave: () => void; connectionError: string };

export function RoomView({ id, joined, onLeave, connectionError }: Props) {
  const room = useRoomContext();
  const participants = useParticipants();
  const cameras = useTracks([Track.Source.Camera]);
  const screens = useTracks([Track.Source.ScreenShare]);
  const [state, setState] = useState<RoomState | null>(null);
  const [error, setError] = useState("");
  const [panel, setPanel] = useState<"chat" | "people" | null>("chat");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const [drafts, setDrafts] = useState<Array<{ id: string; kind: Tool; payload: AnnotationPayload }>>([]);
  const [mic, setMic] = useState(room.localParticipant.isMicrophoneEnabled);
  const [cam, setCam] = useState(room.localParticipant.isCameraEnabled);
  const chatEnd = useRef<HTMLDivElement>(null);
  const activeIds = useMemo(() => new Set(participants.map((person) => person.identity)), [participants]);
  const self = state?.members.find((item) => item.id === joined.member.id);
  const role = self?.role || joined.member.role;
  const canDraw = role === "host" || Boolean(self?.can_annotate);
  const canPublish = role !== "viewer";
  const activeScreen = screens.find((track) => track.participant.identity === state?.room.activeShareOwner) || screens[0];
  const isSharing = Boolean(activeScreen?.participant.identity === joined.member.id);
  const visibleMembers = state?.members.filter((person) => activeIds.has(person.id)) || [];

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
      if (next.room.status !== "open") setError("Ведущий завершил комнату");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось обновить комнату"); }
  }, [api]);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [refresh]);

  useEffect(() => {
    const onData = (payload: Uint8Array, participant?: { identity: string }, _kind?: unknown, topic?: string) => {
      try {
        const data = JSON.parse(new TextDecoder().decode(payload));
        if (topic === "confa" && data.type === "state-changed") void refresh();
        if (topic === "confa-annotation-draft" && participant && data.shareId === state?.room.activeShareId) {
          const source = state?.members.find((member) => member.id === participant.identity);
          if (!source || (source.role !== "host" && !source.can_annotate)) return;
          setDrafts((current) => {
            const rest = current.filter((item) => item.id !== participant.identity);
            return data.payload && Array.isArray(data.payload.points) ? [...rest, { id: participant.identity, kind: data.kind, payload: data.payload }] : rest;
          });
        }
      } catch { /* Ignore malformed data */ }
    };
    room.on(RoomEvent.DataReceived, onData);
    return () => { room.off(RoomEvent.DataReceived, onData); };
  }, [room, refresh, state]);

  useEffect(() => { chatEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [state?.messages.length]);
  useEffect(() => {
    const sync = () => { setMic(room.localParticipant.isMicrophoneEnabled); setCam(room.localParticipant.isCameraEnabled); };
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
  async function toggleCam() {
    try { await room.localParticipant.setCameraEnabled(!cam); setCam(!cam); }
    catch { setError("Нет доступа к камере"); }
  }
  async function toggleShare() {
    setBusy("share");
    try {
      if (isSharing) {
        await room.localParticipant.setScreenShareEnabled(false);
        await api("share", { action: "stop" });
      } else {
        await room.localParticipant.setScreenShareEnabled(true);
        try { await api("share", { action: "start" }); }
        catch (error) { await room.localParticipant.setScreenShareEnabled(false); throw error; }
      }
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось показать экран"); }
    finally { setBusy(""); }
  }
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
    await action("annotations", { action: "add", kind, payload });
  }
  async function annotationAction(name: "undo" | "clear" | "erase", targetId?: string) {
    await action("annotations", { action: name, targetId });
  }
  async function copyGuestLink() {
    try { await navigator.clipboard.writeText(joined.guestUrl); }
    catch { setError("Не удалось скопировать ссылку"); }
  }

  const recordingStatus = state?.recording?.status;

  return <main className="flex h-dvh min-h-[540px] flex-col overflow-hidden bg-[#0e192c] text-white">
    <RoomAudioRenderer />
    <header className="flex min-h-16 items-center justify-between gap-3 border-b border-white/10 px-4 sm:px-6">
      <div className="flex min-w-0 items-center gap-3"><span className="brand-mark !h-9 !w-9 !rounded-xl"><Video size={19} /></span><div className="min-w-0"><h1 className="truncate text-base font-semibold">{joined.kind === "webinar" ? "Вебинар" : "Встреча"}</h1><p className="text-xs text-slate-400">{visibleMembers.length} из 50 участников</p></div></div>
      <div className="flex items-center gap-2">
        {recordingStatus === "recording" && <span className="flex items-center gap-2 rounded-full bg-rose-500/15 px-3 py-1.5 text-xs font-medium text-rose-200"><span className="h-2 w-2 animate-pulse rounded-full bg-rose-400" /> Идёт запись</span>}
        {recordingStatus === "processing" && <span className="rounded-full bg-amber-400/15 px-3 py-1.5 text-xs text-amber-200">Готовим запись</span>}
        <Button variant="outline" size="sm" className="border-white/20 bg-white/5 text-white hover:bg-white/10 hover:text-white" onClick={() => void copyGuestLink()}><Copy size={15} /><span className="hidden sm:inline">Ссылка для гостей</span></Button>
      </div>
    </header>

    {(error || connectionError) && <div role="alert" className="flex items-center justify-between gap-3 bg-rose-500/15 px-5 py-2 text-sm text-rose-100"><span>{connectionError || error}</span><button aria-label="Закрыть сообщение" onClick={() => setError("")}><X size={16} /></button></div>}

    <div className="flex min-h-0 flex-1">
      <section className="flex min-w-0 flex-1 flex-col p-3 sm:p-5">
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          {activeScreen ? <div className="relative min-h-0 flex-1 overflow-hidden rounded-2xl bg-[#16253b]">
            <SharedScreen trackRef={activeScreen}>
              {state?.room.activeShareId && <AnnotationLayer key={state.room.activeShareId} annotations={state.annotations} canDraw={canDraw} canClear={role === "host"} onAdd={addAnnotation} onAction={annotationAction} onDraft={sendDraft} drafts={drafts} />}
            </SharedScreen>
            <span className="absolute left-4 top-4 rounded-lg bg-[#0e192c]/80 px-3 py-1.5 text-xs text-white">{activeScreen.participant.name || "Демонстрация экрана"}</span>
          </div> : <div className="flex min-h-0 flex-1 flex-col items-center justify-center rounded-2xl border border-dashed border-white/10 bg-[#16253b]/65 px-5 text-center"><MonitorUp size={42} className="mb-4 text-[#6de7d4]" /><h2 className="text-xl font-semibold">Комната готова</h2><p className="mt-2 max-w-sm text-sm leading-relaxed text-slate-400">Включите камеру или покажите экран, чтобы начать совместную работу.</p></div>}
          <div className={`grid gap-2 overflow-y-auto ${activeScreen ? "max-h-[160px] grid-flow-col auto-cols-[minmax(120px,1fr)] overflow-x-auto" : "min-h-0 flex-1 grid-cols-[repeat(auto-fit,minmax(165px,1fr))] content-center"}`}>
            {visibleMembers.map((person) => {
              const video = cameras.find((track) => track.participant.identity === person.id);
              return <div key={person.id} className="relative aspect-video min-h-[100px] overflow-hidden rounded-xl bg-[#213650]">
                {video ? <VideoTrack trackRef={video} className="h-full w-full object-cover" /> : <div className="grid h-full place-items-center"><span className="grid h-12 w-12 place-items-center rounded-full bg-[#6de7d4]/20 text-lg font-semibold text-[#9af4e7]">{person.name.charAt(0).toUpperCase()}</span></div>}
                <span className="absolute bottom-2 left-2 max-w-[calc(100%-16px)] truncate rounded bg-[#0b1728]/70 px-2 py-1 text-xs">{person.name}{person.id === joined.member.id ? " (вы)" : ""}{person.raised_hand ? " ✋" : ""}</span>
              </div>;
            })}
          </div>
        </div>
      </section>

      {panel && <aside className="z-10 flex w-[min(360px,100vw)] shrink-0 flex-col border-l border-white/10 bg-[#17263e] max-md:absolute max-md:bottom-[72px] max-md:right-0 max-md:top-16 max-md:shadow-2xl">
        <Tabs value={panel} onValueChange={(value) => setPanel(value as "chat" | "people")} className="flex h-full min-h-0 flex-col gap-0">
          <div className="flex items-center justify-between border-b border-white/10 px-4 py-3"><TabsList className="bg-[#283a54]"><TabsTrigger value="chat">Чат</TabsTrigger><TabsTrigger value="people">Участники</TabsTrigger></TabsList><Button variant="ghost" size="icon" aria-label="Закрыть панель" className="text-slate-300 hover:bg-white/10 hover:text-white" onClick={() => setPanel(null)}><X /></Button></div>
          <TabsContent value="chat" className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">{state?.messages.length ? state.messages.map((item) => <div key={item.id} className="space-y-1"><div className="flex items-baseline justify-between gap-2"><strong className="text-sm text-[#9af4e7]">{item.name}</strong><span className="text-xs text-slate-500">{new Date(item.created_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</span></div><p className="break-words text-sm leading-relaxed text-slate-100">{item.body}</p></div>) : <p className="pt-8 text-center text-sm text-slate-400">Сообщений пока нет</p>}<div ref={chatEnd} /></div>
            <form onSubmit={(event) => void sendMessage(event)} className="flex gap-2 border-t border-white/10 p-3"><input aria-label="Сообщение" maxLength={1000} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Написать сообщение…" className="h-10 min-w-0 flex-1 rounded-lg border border-white/15 bg-[#213650] px-3 text-sm outline-none focus:border-[#6de7d4]" /><Button type="submit" disabled={!message.trim() || busy === "message"} className="bg-[#6de7d4] text-[#10243a] hover:bg-[#96f5e7]">Отправить</Button></form>
          </TabsContent>
          <TabsContent value="people" className="min-h-0 flex-1 overflow-y-auto p-3">
            <p className="px-2 pb-2 text-xs uppercase tracking-[.12em] text-slate-400">В комнате · {visibleMembers.length}</p>
            {visibleMembers.map((person) => <div key={person.id} className="mb-2 rounded-xl bg-[#20344e] p-3">
              <div className="flex items-center gap-2"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[#6de7d4]/20 text-sm font-semibold text-[#9af4e7]">{person.name.charAt(0).toUpperCase()}</span><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{person.name}{person.id === joined.member.id ? " (вы)" : ""}</p><p className="text-xs text-slate-400">{person.role === "host" ? "Ведущий" : person.role === "speaker" ? "Выступающий" : "Зритель"}{person.raised_hand ? " · поднял руку" : ""}</p></div></div>
              {role === "host" && person.id !== joined.member.id && <div className="mt-3 flex flex-wrap gap-1.5">
                {joined.kind === "webinar" && <Button size="xs" variant="secondary" onClick={() => void action(`members/${person.id}`, { action: "role", role: person.role === "viewer" ? "speaker" : "viewer" })}>{person.role === "viewer" ? "На сцену" : "В зрители"}</Button>}
                <Button size="xs" variant="secondary" onClick={() => void action(`members/${person.id}`, { action: "annotation", enabled: !person.can_annotate })}>{person.can_annotate ? "Запретить пометки" : "Разрешить пометки"}</Button>
                <Button size="xs" variant="secondary" onClick={() => void action(`members/${person.id}`, { action: "mute" })}>Выключить звук</Button>
                <Button size="xs" variant="destructive" onClick={() => { if (confirm(`Удалить участника ${person.name}?`)) void action(`members/${person.id}`, { action: "remove" }); }}>Удалить</Button>
              </div>}
            </div>)}
          </TabsContent>
        </Tabs>
      </aside>}
    </div>

    <footer className="flex min-h-[72px] items-center justify-between gap-2 border-t border-white/10 bg-[#15243a] px-3 sm:px-6">
      <div className="hidden min-w-0 sm:block"><p className="truncate text-sm font-medium">{joined.member.name}</p><p className="text-xs text-slate-400">{role === "host" ? "Ведущий" : role === "speaker" ? "Выступающий" : "Зритель"}</p></div>
      <div className="flex flex-1 items-center justify-center gap-1.5 sm:gap-2">
        {canPublish && <>
          <Button variant="secondary" size="icon-lg" title={mic ? "Выключить микрофон" : "Включить микрофон"} aria-label={mic ? "Выключить микрофон" : "Включить микрофон"} className="rounded-full bg-[#2d415d] text-white hover:bg-[#3e5673]" onClick={() => void toggleMic()}>{mic ? <Mic /> : <MicOff />}</Button>
          <Button variant="secondary" size="icon-lg" title={cam ? "Выключить камеру" : "Включить камеру"} aria-label={cam ? "Выключить камеру" : "Включить камеру"} className="rounded-full bg-[#2d415d] text-white hover:bg-[#3e5673]" onClick={() => void toggleCam()}>{cam ? <Video /> : <VideoOff />}</Button>
          <Button variant="secondary" size="icon-lg" title={isSharing ? "Остановить демонстрацию" : "Показать экран"} aria-label={isSharing ? "Остановить демонстрацию" : "Показать экран"} disabled={busy === "share"} className={`rounded-full text-white hover:bg-[#3e5673] ${isSharing ? "bg-[#317b75]" : "bg-[#2d415d]"}`} onClick={() => void toggleShare()}>{isSharing ? <MonitorX /> : <MonitorUp />}</Button>
        </>}
        <Button variant="secondary" size="icon-lg" title="Поднять или опустить руку" aria-label="Поднять или опустить руку" className={`rounded-full text-white hover:bg-[#3e5673] ${self?.raised_hand ? "bg-amber-500/40" : "bg-[#2d415d]"}`} onClick={() => void action("hand", {})}><Hand /></Button>
        <Button variant="secondary" size="icon-lg" title="Чат" aria-label="Чат" className="rounded-full bg-[#2d415d] text-white hover:bg-[#3e5673]" onClick={() => setPanel(panel === "chat" ? null : "chat")}><MessageSquare /></Button>
        <Button variant="secondary" size="icon-lg" title="Участники" aria-label="Участники" className="rounded-full bg-[#2d415d] text-white hover:bg-[#3e5673]" onClick={() => setPanel(panel === "people" ? null : "people")}><Users /></Button>
        {role === "host" && <Button variant="secondary" size="icon-lg" title={recordingStatus === "recording" ? "Остановить запись" : "Начать запись"} aria-label={recordingStatus === "recording" ? "Остановить запись" : "Начать запись"} disabled={busy === "recording" || recordingStatus === "processing"} className={`rounded-full text-white hover:bg-[#3e5673] ${recordingStatus === "recording" ? "bg-rose-500/40" : "bg-[#2d415d]"}`} onClick={() => void action("recording", { action: recordingStatus === "recording" ? "stop" : "start" }, "recording")}><Radio /></Button>}
      </div>
      <div className="flex items-center gap-2">
        {state?.recording?.url && <a href={state.recording.url} target="_blank" rel="noreferrer" className="hidden text-xs text-[#9af4e7] underline sm:inline">Открыть запись</a>}
        <Button variant="destructive" size="sm" className="rounded-xl" onClick={() => { if (role === "host") { if (confirm("Завершить комнату для всех?")) void action("end", {}).then((result) => { if (result) onLeave(); }); } else { room.disconnect(); onLeave(); } }}><PhoneOff size={16} /><span className="hidden sm:inline">{role === "host" ? "Завершить" : "Выйти"}</span></Button>
      </div>
    </footer>
  </main>;
}
