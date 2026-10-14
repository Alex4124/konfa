"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { LiveKitRoom } from "@livekit/components-react";
import { createLocalVideoTrack, type LocalVideoTrack, type RoomOptions } from "livekit-client";
import { ArrowLeft, Camera, CameraOff, Mic, MicOff, SwitchCamera, Video, Users, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { RoomView } from "@/components/room-view";
import { BackgroundPicker, type VideoBackground } from "@/components/background-picker";
import { createStableBackgroundProcessor } from "@/lib/stable-background";
import { DEFAULT_FACING, flipLabel, oppositeFacing, type Facing } from "@/lib/camera-facing";
import { useCameraCount } from "@/hooks/use-camera-count";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useNoiseFilterPref, useNoiseFilterSupported } from "@/hooks/use-noise-filter-pref";
import type { RoomKind, Role } from "@/lib/confa-types";

type Joined = {
  member: { id: string; name: string; role: Role; canAnnotate: boolean };
  sessionToken: string; livekitToken: string; livekitUrl: string; guestUrl: string; seriesUrl?: string | null; kind: RoomKind;
};

// Each camera arrives at the size of its tile (in screen pixels, so a scaled display stays sharp) and stops while nobody
// shows it; a publisher does not encode the layers nobody asked for. One object for the life of the page: a new one
// would make LiveKitRoom build a new room.
const ROOM_OPTIONS: RoomOptions = { adaptiveStream: { pixelDensity: "screen" }, dynacast: true };

export default function RoomPage() {
  const params = useParams();
  const id = String(params.id || "");
  const [room, setRoom] = useState<{ kind: RoomKind; status: string; seriesUrl: string | null } | null>(null);
  const [name, setName] = useState("");
  const [camera, setCamera] = useState(false);
  const [microphone, setMicrophone] = useState(false);
  const [noiseFilter, setNoiseFilter] = useNoiseFilterPref();
  const noiseSupported = useNoiseFilterSupported();
  const [joined, setJoined] = useState<Joined | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [isHostLink, setIsHostLink] = useState(false);
  const [conferenceEnded, setConferenceEnded] = useState(false);
  const [background, setBackground] = useState<VideoBackground | null>(null);
  const backgroundUrls = useRef<string[]>([]);
  const previewRef = useRef<HTMLVideoElement>(null);
  // Front or back camera on a phone or a tablet; the room opens the same side.
  const [facing, setFacing] = useState<Facing>(DEFAULT_FACING);
  // A camera has opened on this page, so the device lists all its cameras.
  const [cameraAllowed, setCameraAllowed] = useState(false);
  const previewChain = useRef<Promise<void>>(Promise.resolve());
  const coarse = useMediaQuery("(pointer: coarse)");
  const cameraCount = useCameraCount(coarse && cameraAllowed);
  const canFlip = coarse && camera && cameraCount >= 2;

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
    fetch("/api/account").then((response) => response.json() as Promise<{ account?: { name: string } }>).then((data) => {
      if (data.account?.name && !localStorage.getItem("confa-name")) setName(data.account.name);
    }).catch(() => {});
    fetch(`/api/rooms/${id}`).then(async (response) => {
      const data = await response.json() as { error?: string; kind: RoomKind; status: string; seriesUrl: string | null };
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
    // A touch device names the side; a computer opens its default camera as before.
    const side = coarse ? { facingMode: facing } : undefined;
    const start = async () => {
      if (cancelled) return;
      try {
        if (background) {
          try {
            previewTrack = await createLocalVideoTrack({ ...side, processor: createStableBackgroundProcessor(background.url, (message) => setError(message)) });
            if (cancelled) { previewTrack.stop(); return; }
            previewTrack.attach(preview);
            setCameraAllowed(true);
            return;
          } catch (cause) {
            if (!cancelled) setError(cause instanceof Error ? cause.message : "Обработка фона недоступна");
          }
        }
        {
          stream = await navigator.mediaDevices.getUserMedia({ video: side ?? true, audio: false });
          if (cancelled) { stream.getTracks().forEach((track) => track.stop()); return; }
          preview.srcObject = stream;
          setCameraAllowed(true);
        }
      } catch (cause) {
        if (!cancelled) { setCamera(false); setError(cause instanceof Error ? cause.message : "Нет доступа к камере"); }
      }
    };
    // A phone cannot open its other camera while one is running: each preview starts after the previous one has opened
    // and released its camera.
    previewChain.current = previewChain.current.then(start);
    return () => {
      cancelled = true;
      // stop() releases the camera at once and destroys the background processor itself.
      if (previewTrack) { previewTrack.detach(); previewTrack.stop(); }
      stream?.getTracks().forEach((track) => track.stop());
      preview.srcObject = null;
    };
  }, [camera, background, joined, coarse, facing]);

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

  if (conferenceEnded) return <main className="grid min-h-dvh place-items-center bg-[#0e192c] px-5 text-white"><div className="text-center"><h1 className="text-3xl font-semibold">Конференция завершена</h1><p className="mt-3 text-slate-300">Ведущий закончил конференцию для всех участников.</p><Button className="mt-6" onClick={() => window.location.assign("/")}>На главную</Button></div></main>;

  if (joined) return <LiveKitRoom token={joined.livekitToken} serverUrl={joined.livekitUrl} options={ROOM_OPTIONS} connect audio={joined.member.role !== "viewer" && microphone} video={false} onError={(cause) => setError(cause.message)} onDisconnected={() => setError("Связь с комнатой прервана. Обновите страницу для повторного входа.")}>
    <RoomView id={id} joined={joined} initialCamera={camera} initialFacing={facing} background={background} onBackgroundChange={changeBackground} onLeave={() => { setJoined(null); window.location.assign(joined.seriesUrl || "/"); }} onEnded={() => { setJoined(null); if (joined.seriesUrl) window.location.assign(joined.seriesUrl); else setConferenceEnded(true); }} connectionError={error} />
  </LiveKitRoom>;

  // The room can be missing, so leaving this page must bypass client-side routing.
  // eslint-disable-next-line @next/next/no-html-link-for-pages
  const homeLink = <a href="/" className="inline-flex items-center gap-2 text-sm text-slate-300 hover:text-white"><ArrowLeft size={17} /> На главную</a>;

  return <main className="prejoin min-h-dvh bg-[#0e192c] text-white">
    <div className="mx-auto max-w-6xl px-5 py-4 sm:py-7">{homeLink}</div>
    <div className="mx-auto grid max-w-6xl gap-9 px-5 pb-14 pt-2 sm:pt-7 lg:grid-cols-[1.1fr_.9fr] lg:items-center lg:gap-16 lg:pt-16">
      <div className="relative aspect-video overflow-hidden rounded-[28px] border border-white/10 bg-[#1c2d46] shadow-2xl">
        {camera ? <video ref={previewRef} autoPlay muted playsInline className="h-full w-full object-cover" /> : <div className="flex h-full flex-col items-center justify-center gap-3 text-slate-400"><span className="grid h-20 w-20 place-items-center rounded-full bg-white/10"><CameraOff size={30} /></span>Камера выключена</div>}
        <div className="absolute bottom-5 left-1/2 flex -translate-x-1/2 gap-3">
          <Button variant="secondary" size="icon-lg" className="rounded-full bg-[#314763] text-white hover:bg-[#405a76]" title={microphone ? "Выключить микрофон" : "Включить микрофон"} onClick={() => setMicrophone(!microphone)}>{microphone ? <Mic /> : <MicOff />}</Button>
          <Button variant="secondary" size="icon-lg" className="rounded-full bg-[#314763] text-white hover:bg-[#405a76]" title={camera ? "Выключить камеру" : "Включить камеру"} onClick={() => setCamera(!camera)}>{camera ? <Camera /> : <CameraOff />}</Button>
          {canFlip && <Button variant="secondary" size="icon-lg" className="rounded-full bg-[#314763] text-white hover:bg-[#405a76]" title={flipLabel(facing)} aria-label={flipLabel(facing)} onClick={() => setFacing(oppositeFacing(facing))}><SwitchCamera /></Button>}
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
        <label className="mt-4 flex w-fit max-w-md items-center gap-3 text-sm text-slate-200"><Switch checked={noiseFilter && noiseSupported} disabled={!noiseSupported} onCheckedChange={setNoiseFilter} className="data-[state=checked]:bg-[#6de7d4] data-[state=unchecked]:bg-[#314763] [&_[data-slot=switch-thumb]]:!bg-white" /><span>Шумоподавление<span className="block text-xs text-slate-400">{noiseSupported ? "Убирает фоновый шум: клавиатуру, вентилятор, улицу" : "Недоступно в этом браузере"}</span></span></label>
        <div className="mt-6"><Button className="h-13 rounded-xl bg-[#6de7d4] px-7 text-base font-semibold text-[#10243a] hover:bg-[#96f5e7]" disabled={busy || !room || room.status !== "open"} onClick={() => void join()}>{busy ? "Подключаем…" : "Войти"}</Button></div>
        {error && <p role="alert" className="mt-4 max-w-md text-sm text-rose-300">{error}</p>}
        {room?.status === "ended" && <p className="mt-4 text-rose-300">Эта комната уже завершена</p>}
        <p className="mt-6 flex items-center gap-2 text-sm text-slate-400"><ShieldCheck size={17} /> Видеозапись включается ведущим вручную</p>
      </div>
    </div>
  </main>;
}
