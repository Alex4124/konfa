"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { LiveKitRoom, RoomAudioRenderer, useRoomContext, useTracks, VideoTrack } from "@livekit/components-react";
import { RoomEvent, Track, type RemoteParticipant } from "livekit-client";
import { AnnotationLayer } from "@/components/annotations/annotation-layer";
import { SharedScreen } from "@/components/shared-screen";
import { createStateRefresher, useAnnotationSync, windowTimers } from "@/hooks/use-annotation-sync";
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
  const room = useRoomContext();
  const [state, setState] = useState<RoomState | null>(null);
  const screens = useTracks([Track.Source.ScreenShare]);
  const cameras = useTracks([Track.Source.Camera]);
  const screen = screens.find((item) => item.participant.identity === state?.room.activeShareOwner) || screens[0];
  const ready = connected && Boolean(state);
  // Marks belong to the active share only; a leftover screen of someone else is recorded clean.
  const showMarks = Boolean(screen && state?.room.activeShareId && screen.participant.identity === state.room.activeShareOwner);
  const sync = useAnnotationSync({ room, roomId, token: access, self: null, state, requestRefresh: () => void refresh() });
  const [refresher] = useState(() => {
    let stateKey = "";
    return createStateRefresher({
      fetchState: async (signal) => {
        const response = await fetch(`/api/rooms/${roomId}/state`, { headers: { Authorization: `Bearer ${access}` }, signal });
        if (!response.ok) throw new Error(`state ${response.status}`);
        return await response.json() as RoomState;
      },
      sync,
      onState: (next) => {
        const rest = { ...next, annotations: [] };
        const key = JSON.stringify(rest);
        if (key === stateKey) return;
        stateKey = key;
        setState(rest);
      },
      onError: () => { /* Retry on the next poll */ },
      timers: windowTimers,
      now: () => performance.now(),
    });
  });
  const refresh = useCallback(() => refresher.run(), [refresher]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    const onData = (payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
      if (topic !== "confa" || participant) return;
      try {
        if (JSON.parse(new TextDecoder().decode(payload))?.type === "state-changed") void refresh();
      } catch { /* Ignore malformed data */ }
    };
    room.on(RoomEvent.DataReceived, onData);
    return () => { room.off(RoomEvent.DataReceived, onData); };
  }, [room, refresh]);

  useEffect(() => { if (ready) console.log("START_RECORDING"); }, [ready]);

  return <main className="flex h-screen w-screen flex-col gap-3 overflow-hidden bg-[#0e192c] p-5 text-white">
    <RoomAudioRenderer />
    <div className="flex items-center justify-between"><strong className="text-xl">конфа<span className="text-[#6de7d4]">.</span></strong><span className="text-sm text-slate-400">{state?.room.kind === "webinar" ? "Вебинар" : "Встреча"}</span></div>
    {screen ? <div className="relative min-h-0 flex-1 overflow-hidden rounded-2xl bg-[#17263e]">
      <SharedScreen trackRef={screen} resetKey={state?.room.activeShareId}>{showMarks && state?.room.activeShareId && <AnnotationLayer key={state.room.activeShareId} shareId={state.room.activeShareId} sync={sync} canDraw={false} showSavedAuthors={false} />}</SharedScreen>
    </div> : <div className="grid min-h-0 flex-1 grid-cols-3 gap-3 overflow-hidden">
      {cameras.slice(0, 9).map((camera) => <div key={camera.participant.identity} className="relative overflow-hidden rounded-2xl bg-[#17263e]"><VideoTrack trackRef={camera} className="h-full w-full object-cover" /><span className="absolute bottom-3 left-3 rounded-lg bg-[#0e192c]/70 px-2 py-1 text-sm">{camera.participant.name}</span></div>)}
    </div>}
    {screen && <div className="flex h-32 gap-3 overflow-hidden">{cameras.slice(0, 7).map((camera) => <div key={camera.participant.identity} className="relative aspect-video overflow-hidden rounded-xl bg-[#17263e]"><VideoTrack trackRef={camera} className="h-full w-full object-cover" /></div>)}</div>}
  </main>;
}
