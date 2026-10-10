"use client";

import { useCallback, useSyncExternalStore } from "react";
import { ParticipantEvent, type Participant } from "livekit-client";

const EVENTS = [
  ParticipantEvent.TrackMuted, ParticipantEvent.TrackUnmuted, ParticipantEvent.TrackPublished, ParticipantEvent.TrackUnpublished,
  ParticipantEvent.LocalTrackPublished, ParticipantEvent.LocalTrackUnpublished, ParticipantEvent.IsSpeakingChanged,
] as const;
const MICROPHONE = 1, CAMERA = 2, SPEAKING = 4;

// One number, so the snapshot stays the same until something changes.
function read(participant: Participant | undefined): number {
  if (!participant) return 0;
  return (participant.isMicrophoneEnabled ? MICROPHONE : 0) | (participant.isCameraEnabled ? CAMERA : 0) | (participant.isSpeaking ? SPEAKING : 0);
}

const serverMedia = () => 0;

// What a tile shows about its participant, read from the participant's own events: a tile does not wait for the room to
// re-render. A microphone or a camera that was never published counts as off.
export function useParticipantMedia(participant: Participant | undefined): { microphone: boolean; camera: boolean; speaking: boolean } {
  const subscribe = useCallback((onChange: () => void) => {
    if (!participant) return () => {};
    for (const event of EVENTS) participant.on(event, onChange);
    return () => { for (const event of EVENTS) participant.off(event, onChange); };
  }, [participant]);
  const bits = useSyncExternalStore(subscribe, () => read(participant), serverMedia);
  return { microphone: Boolean(bits & MICROPHONE), camera: Boolean(bits & CAMERA), speaking: Boolean(bits & SPEAKING) };
}
