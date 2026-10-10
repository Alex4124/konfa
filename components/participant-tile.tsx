"use client";

import { memo, useMemo } from "react";
import { VideoTrack, type TrackReference } from "@livekit/components-react";
import { Track, type Participant, type TrackPublication } from "livekit-client";
import { MicOff } from "lucide-react";
import { useParticipantMedia } from "@/hooks/use-participant-media";

// fit: fills a slot sized by TileGrid or TileStrip; top and left size themselves in a row or a column (a scrolling strip
// and the participants panel over an expanded screen share).
export type TileLayout = "fit" | "top" | "left";
type Props = {
  name: string;
  self: boolean;
  raisedHand: boolean;
  canSpeak: boolean; // a viewer of a webinar has no microphone to show as off
  participant?: Participant;
  camera?: TrackPublication; // the subscribed camera, if any
  layout: TileLayout;
};

const SIZE: Record<TileLayout, string> = { fit: "h-full w-full", top: "h-full aspect-video shrink-0", left: "w-full aspect-video shrink-0" };

// One participant: the camera whole in a 16:9 tile (a phone or a 4:3 camera gets bars, never a crop), the initial when
// the camera is off or paused, a ring while they speak and a crossed microphone when they are muted.
export const ParticipantTile = memo(function ParticipantTile({ name, self, raisedHand, canSpeak, participant, camera, layout }: Props) {
  const media = useParticipantMedia(participant);
  const trackRef = useMemo<TrackReference | null>(() => participant && camera ? { participant, publication: camera, source: Track.Source.Camera } : null, [participant, camera]);
  return <div className={`@container relative min-w-0 overflow-hidden rounded-xl bg-[#213650] ${SIZE[layout]}`}>
    {trackRef && media.camera
      ? <VideoTrack trackRef={trackRef} className="h-full w-full object-contain" />
      : <div className="grid h-full place-items-center pb-5 @[160px]:pb-0"><span className="grid h-6 w-6 place-items-center rounded-full bg-[#6de7d4]/20 text-xs font-semibold text-[#9af4e7] @[120px]:h-8 @[120px]:w-8 @[120px]:text-sm @[160px]:h-12 @[160px]:w-12 @[160px]:text-lg">{name.charAt(0).toUpperCase()}</span></div>}
    <span className="absolute bottom-1 left-1 flex max-w-[calc(100%-8px)] items-center gap-1 rounded bg-[#0b1728]/70 px-1.5 py-0.5 text-xs @[220px]:bottom-2 @[220px]:left-2 @[220px]:max-w-[calc(100%-16px)] @[220px]:px-2 @[220px]:py-1">
      {canSpeak && !media.microphone && <MicOff size={12} role="img" aria-label="Микрофон выключен" className="shrink-0 text-rose-300" />}
      <span className="truncate">{name}{self ? " (вы)" : ""}</span>
      {raisedHand && <span className="shrink-0">✋</span>}
    </span>
    {media.speaking && media.microphone && <span aria-hidden className="pointer-events-none absolute inset-0 rounded-xl ring-2 ring-inset ring-[#6de7d4]" />}
  </div>;
});
