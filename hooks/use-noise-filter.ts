"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LocalAudioTrack, RoomEvent, Track, type LocalTrackPublication, type Room } from "livekit-client";
import { toast } from "sonner";
import { NOISE_FILTER_NAME, noiseFilterStep } from "@/lib/noise-filter";
import { createNoiseFilter } from "@/lib/noise-processor";

export type NoiseFilterStatus = "on" | "off" | "unsupported" | "failed";

// Keeps the published microphone's noise filter in line with the participant's choice. The filter goes on once LiveKit
// has published the track (LiveKit gives the track its audio context there) and again after a republish; muting, the
// teacher's «Выключить звук» included, keeps it. When it fails or stalls the raw microphone goes out, the participant is
// told once, and only their click tries again on this page.
export function useNoiseFilter(room: Room, wanted: boolean, supported: boolean): { status: NoiseFilterStatus; retry: () => void } {
  const [failed, setFailed] = useState(false);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const wantedRef = useRef(wanted);
  const failedRef = useRef(false);

  const sync = useCallback(() => {
    const enqueue = (task: () => Promise<void>) => { queue.current = queue.current.catch(() => {}).then(task); };
    enqueue(async () => {
      const track = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
      if (!(track instanceof LocalAudioTrack)) return;
      const current = track.getProcessor();
      const attached = !current ? "none" : current.name === NOISE_FILTER_NAME ? "ours" : "other";
      const step = noiseFilterStep({ wanted: wantedRef.current, available: supported && !failedRef.current, attached });
      if (step === "remove") await track.stopProcessor();
      if (step !== "apply") return;
      const fail = (text: string) => {
        failedRef.current = true;
        setFailed(true);
        toast.error(text, { id: "noise-filter" });
      };
      const filter = createNoiseFilter({
        // The filter stopped mid-lesson: take it off this track (if it is still there) so the voice goes out raw.
        onStalled: () => {
          if (track.getProcessor() !== filter) return;
          fail("Шумоподавление остановилось — микрофон работает без него");
          enqueue(async () => { if (track.getProcessor() === filter) await track.stopProcessor(); });
        },
      });
      try { await track.setProcessor(filter); }
      catch {
        await track.stopProcessor().catch(() => {});
        fail("Не удалось включить шумоподавление — микрофон работает без него");
      }
    });
  }, [room, supported]);

  useEffect(() => {
    wantedRef.current = wanted;
    sync();
  }, [wanted, sync]);

  useEffect(() => {
    const published = (publication: LocalTrackPublication) => {
      if (publication.source === Track.Source.Microphone) sync();
    };
    room.on(RoomEvent.LocalTrackPublished, published);
    return () => { room.off(RoomEvent.LocalTrackPublished, published); };
  }, [room, sync]);

  const retry = useCallback(() => {
    failedRef.current = false;
    setFailed(false);
    toast.dismiss("noise-filter");
    sync();
  }, [sync]);

  const status: NoiseFilterStatus = !supported ? "unsupported" : !wanted ? "off" : failed ? "failed" : "on";
  return { status, retry };
}
