"use client";

import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { LiveKitRoom, RoomAudioRenderer, useTracks, VideoTrack } from "@livekit/components-react";
import { Track } from "livekit-client";
import { AnnotationLayer } from "@/components/annotation-layer";
import { SharedScreen } from "@/components/shared-screen";
import type { RoomState } from "@/lib/confa-types";

export default function EgressPage() {
  const params = useParams();
  const roomId = String(params.id || "");
  const query = useSearchParams();
  const url = query.get("url"), token = query.get("token"), access = query.get("access");
  const [connected, setConnected] = useState(false);
  if (!url || !token || !access) return <main className="grid min-h-screen place-items-center bg-[#0e192c] text-white">Подготовка записи…</main>;
  return <LiveKitRoom serverUrl={url} token={token} connect onConnected={() => setConnected(true)} onDisconnected={() => console.log("END_RECORDING")}>
    <RecordingScene roomId={roomId} access={access} connected={connected} />
  </LiveKitRoom>;
}

function RecordingScene({ roomId, access, connected }: { roomId: string; access: string; connected: boolean }) {
  const [state, setState] = useState<RoomState | null>(null);
  const screens = useTracks([Track.Source.ScreenShare]);
  const cameras = useTracks([Track.Source.Camera]);
  const screen = screens.find((item) => item.participant.identity === state?.room.activeShareOwner) || screens[0];
  const ready = connected && Boolean(state);

  useEffect(() => {
    let live = true;
    const refresh = async () => {
      try {
        const response = await fetch(`/api/rooms/${roomId}/state`, { headers: { Authorization: `Bearer ${access}` } });
        if (response.ok && live) setState(await response.json());
      } catch { /* Retry on next refresh */ }
    };
    void refresh();
    const timer = setInterval(refresh, 1500);
    return () => { live = false; clearInterval(timer); };
  }, [roomId, access]);

  useEffect(() => { if (ready) console.log("START_RECORDING"); }, [ready]);

  return <main className="flex h-screen w-screen flex-col gap-3 overflow-hidden bg-[#0e192c] p-5 text-white">
    <RoomAudioRenderer />
    <div className="flex items-center justify-between"><strong className="text-xl">конфа<span className="text-[#6de7d4]">.</span></strong><span className="text-sm text-slate-400">{state?.room.kind === "webinar" ? "Вебинар" : "Встреча"}</span></div>
    {screen ? <div className="relative min-h-0 flex-1 overflow-hidden rounded-2xl bg-[#17263e]">
      <SharedScreen trackRef={screen}>{state?.room.activeShareId && <AnnotationLayer annotations={state.annotations} />}</SharedScreen>
    </div> : <div className="grid min-h-0 flex-1 grid-cols-3 gap-3 overflow-hidden">
      {cameras.slice(0, 9).map((camera) => <div key={camera.participant.identity} className="relative overflow-hidden rounded-2xl bg-[#17263e]"><VideoTrack trackRef={camera} className="h-full w-full object-cover" /><span className="absolute bottom-3 left-3 rounded-lg bg-[#0e192c]/70 px-2 py-1 text-sm">{camera.participant.name}</span></div>)}
    </div>}
    {screen && <div className="flex h-32 gap-3 overflow-hidden">{cameras.slice(0, 7).map((camera) => <div key={camera.participant.identity} className="relative aspect-video overflow-hidden rounded-xl bg-[#17263e]"><VideoTrack trackRef={camera} className="h-full w-full object-cover" /></div>)}</div>}
  </main>;
}
