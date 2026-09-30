"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { LiveKitRoom } from "@livekit/components-react";
import { BackgroundProcessor, supportsBackgroundProcessors } from "@livekit/track-processors";
import { createLocalVideoTrack, type LocalVideoTrack } from "livekit-client";
import { ArrowLeft, Camera, CameraOff, Mic, MicOff, Video, Users, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RoomView } from "@/components/room-view";
import { BackgroundPicker, type VideoBackground } from "@/components/background-picker";
import type { RoomKind, Role } from "@/lib/confa-types";

type Joined = {
  member: { id: string; name: string; role: Role; canAnnotate: boolean };
  sessionToken: string; livekitToken: string; livekitUrl: string; guestUrl: string; kind: RoomKind;
};

export default function RoomPage() {
  const params = useParams();
  const router = useRouter();
  const id = String(params.id || "");
  const [room, setRoom] = useState<{ kind: RoomKind; status: string } | null>(null);
  const [name, setName] = useState("");
  const [camera, setCamera] = useState(false);
  const [microphone, setMicrophone] = useState(false);
  const [joined, setJoined] = useState<Joined | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [isHostLink, setIsHostLink] = useState(false);
  const [conferenceEnded, setConferenceEnded] = useState(false);
  const [background, setBackground] = useState<VideoBackground | null>(null);
  const backgroundUrls = useRef<string[]>([]);
  const previewRef = useRef<HTMLVideoElement>(null);

  useEffect(() => () => { backgroundUrls.current.forEach((url) => URL.revokeObjectURL(url)); }, []);

  function changeBackground(next: VideoBackground | null) {
    if (next) backgroundUrls.current.push(next.url);
    setBackground(next);
  }

  useEffect(() => {
    const loadBrowserState = () => {
      setName(localStorage.getItem("confa-name") || "");
      setIsHostLink(new URLSearchParams(location.hash.slice(1)).has("host"));
    };
    const initial = window.setTimeout(loadBrowserState, 0);
    fetch(`/api/rooms/${id}`).then(async (response) => {
      const data = await response.json() as { error?: string; kind: RoomKind; status: string };
      if (!response.ok) throw new Error(data.error || "Комната не найдена");
      setRoom(data);
    }).catch((cause) => setError(cause.message));
    return () => window.clearTimeout(initial);
  }, [id]);

  useEffect(() => {
    if (!camera || joined || !previewRef.current) return;
    let cancelled = false;
    let stream: MediaStream | null = null;
    let previewTrack: LocalVideoTrack | null = null;
    const preview = previewRef.current;
    const start = async () => {
      try {
        if (background) {
          if (!supportsBackgroundProcessors()) throw new Error("Этот браузер не поддерживает замену фона");
          previewTrack = await createLocalVideoTrack({ processor: BackgroundProcessor({ mode: "virtual-background", imagePath: background.url }) });
          if (cancelled) { previewTrack.stop(); return; }
          previewTrack.attach(preview);
        } else {
          stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
          if (cancelled) { stream.getTracks().forEach((track) => track.stop()); return; }
          preview.srcObject = stream;
        }
      } catch (cause) {
        if (!cancelled) { setCamera(false); setError(cause instanceof Error ? cause.message : "Нет доступа к камере"); }
      }
    };
    void start();
    return () => {
      cancelled = true;
      if (previewTrack) { previewTrack.detach(); void previewTrack.stopProcessor().finally(() => previewTrack?.stop()); }
      stream?.getTracks().forEach((track) => track.stop());
      preview.srcObject = null;
    };
  }, [camera, background, joined]);

  async function join() {
    if (!name.trim()) { setError("Введите имя"); return; }
    setBusy(true); setError("");
    try {
      const previous = sessionStorage.getItem(`confa-session-${id}`);
      const hostSecret = new URLSearchParams(location.hash.slice(1)).get("host");
      const response = await fetch(`/api/rooms/${id}/join`, {
        method: "POST", headers: { "Content-Type": "application/json", ...(previous ? { Authorization: `Bearer ${previous}` } : {}) },
        body: JSON.stringify({ name: name.trim(), hostSecret }),
      });
      const result = await response.json() as Joined & { error?: string };
      if (!response.ok) throw new Error(result.error || "Не удалось войти");
      localStorage.setItem("confa-name", name.trim());
      sessionStorage.setItem(`confa-session-${id}`, result.sessionToken);
      setJoined(result);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось войти"); }
    finally { setBusy(false); }
  }

  if (conferenceEnded) return <main className="grid min-h-screen place-items-center bg-[#0e192c] px-5 text-white"><div className="text-center"><h1 className="text-3xl font-semibold">Конференция завершена</h1><p className="mt-3 text-slate-300">Ведущий закончил конференцию для всех участников.</p><Button className="mt-6" onClick={() => router.push("/")}>На главную</Button></div></main>;

  if (joined) return <LiveKitRoom token={joined.livekitToken} serverUrl={joined.livekitUrl} connect audio={joined.member.role !== "viewer" && microphone} video={false} onError={(cause) => setError(cause.message)} onDisconnected={() => setError("Связь с комнатой прервана. Обновите страницу для повторного входа.")}>
    <RoomView id={id} joined={joined} initialCamera={camera} background={background} onBackgroundChange={changeBackground} onLeave={() => { setJoined(null); router.push("/"); }} onEnded={() => { setJoined(null); setConferenceEnded(true); }} connectionError={error} />
  </LiveKitRoom>;

  return <main className="prejoin min-h-screen bg-[#0e192c] text-white">
    <div className="mx-auto max-w-6xl px-5 py-7"><Link href="/" className="inline-flex items-center gap-2 text-sm text-slate-300 hover:text-white"><ArrowLeft size={17} /> На главную</Link></div>
    <div className="mx-auto grid max-w-6xl gap-9 px-5 pb-14 pt-7 lg:grid-cols-[1.1fr_.9fr] lg:items-center lg:gap-16 lg:pt-16">
      <div className="relative aspect-video overflow-hidden rounded-[28px] border border-white/10 bg-[#1c2d46] shadow-2xl">
        {camera ? <video ref={previewRef} autoPlay muted playsInline className="h-full w-full object-cover" /> : <div className="flex h-full flex-col items-center justify-center gap-3 text-slate-400"><span className="grid h-20 w-20 place-items-center rounded-full bg-white/10"><CameraOff size={30} /></span>Камера выключена</div>}
        <div className="absolute bottom-5 left-1/2 flex -translate-x-1/2 gap-3">
          <Button variant="secondary" size="icon-lg" className="rounded-full bg-[#314763] text-white hover:bg-[#405a76]" title={microphone ? "Выключить микрофон" : "Включить микрофон"} onClick={() => setMicrophone(!microphone)}>{microphone ? <Mic /> : <MicOff />}</Button>
          <Button variant="secondary" size="icon-lg" className="rounded-full bg-[#314763] text-white hover:bg-[#405a76]" title={camera ? "Выключить камеру" : "Включить камеру"} onClick={() => setCamera(!camera)}>{camera ? <Camera /> : <CameraOff />}</Button>
        </div>
      </div>
      <div>
        <div className="mb-5 flex h-13 w-13 items-center justify-center rounded-2xl bg-[#6de7d4] text-[#10243a]">{room?.kind === "webinar" ? <Users size={25} /> : <Video size={25} />}</div>
        <p className="mb-2 text-sm font-medium uppercase tracking-[.14em] text-[#6de7d4]">{room?.kind === "webinar" ? "Вебинар" : "Видеовстреча"}</p>
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">Войти в комнату</h1>
        <p className="mt-4 max-w-md text-base leading-relaxed text-slate-300">{isHostLink ? "Вы войдёте как ведущий. Ссылку для гостей можно будет скопировать внутри комнаты." : room?.kind === "webinar" ? "Вы войдёте как зритель. Ведущий сможет пригласить вас выступить." : "Проверьте имя, камеру и микрофон перед входом."}</p>
        <label className="mt-8 block text-sm font-medium text-slate-200" htmlFor="display-name">Ваше имя</label>
        <input id="display-name" autoComplete="name" maxLength={60} value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void join(); }} placeholder="Как к вам обращаться" className="mt-2 h-13 w-full max-w-md rounded-xl border border-[#435872] bg-[#1b2c46] px-4 text-base text-white outline-none placeholder:text-slate-400 focus:border-[#6de7d4]" />
        <div className="mt-5"><BackgroundPicker background={background} onChange={changeBackground} onError={setError} /></div>
        <div className="mt-6"><Button className="h-13 rounded-xl bg-[#6de7d4] px-7 text-base font-semibold text-[#10243a] hover:bg-[#96f5e7]" disabled={busy || !room || room.status !== "open"} onClick={() => void join()}>{busy ? "Подключаем…" : "Войти"}</Button></div>
        {error && <p role="alert" className="mt-4 max-w-md text-sm text-rose-300">{error}</p>}
        {room?.status === "ended" && <p className="mt-4 text-rose-300">Эта комната уже завершена</p>}
        <p className="mt-6 flex items-center gap-2 text-sm text-slate-400"><ShieldCheck size={17} /> Видеозапись включается ведущим вручную</p>
      </div>
    </div>
  </main>;
}
