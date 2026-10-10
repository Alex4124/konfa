"use client";

import { useEffect, useEffectEvent, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { VideoTrack } from "@livekit/components-react";
import { RemoteVideoTrack, type ElementInfo } from "livekit-client";
import { ZoomFrame, type FrameInteraction } from "@/components/zoom-frame";
import type { Size } from "@/lib/annotation-geometry";

export { FrameContext, useFrame, type FrameInfo, type FrameInteraction } from "@/components/zoom-frame";

type TrackRef = NonNullable<ComponentProps<typeof VideoTrack>["trackRef"]>;
type Frame = Size & { source: "video" | "provisional" };
type Props = {
  trackRef: TrackRef;
  children?: ReactNode;
  className?: string;
  frameless?: boolean;
  zoomable?: boolean;
  interaction?: FrameInteraction;
  fingersDraw?: boolean; // «Пальцы тоже рисуют»: a pen contact does not switch fingers to pan and zoom
  resetKey?: string | null;
  onFrameChange?: (aspect: number) => void;
  hideVideo?: boolean;
};

const PROVISIONAL_MS = 1200;
const FULL_SIZE = 4096; // asked for until the share reports its own size

function provisionalFrame(publication: TrackRef["publication"]): Frame | null {
  const settings = publication.track?.mediaStreamTrack?.getSettings();
  if (settings?.width && settings.height) return { width: settings.width, height: settings.height, source: "provisional" };
  const dimensions = publication.dimensions;
  if (dimensions?.width && dimensions.height) return { width: dimensions.width, height: dimensions.height, source: "provisional" };
  return null;
}

// The shared screen in a ZoomFrame: the frame takes the video's own size once the video reports it.
export function SharedScreen({ trackRef, children, className = "", frameless = false, zoomable = false, interaction = "view", fingersDraw = false, resetKey = null, onFrameChange, hideVideo = false }: Props) {
  const publication = trackRef.publication;
  const sid = publication.trackSid;
  const [frame, setFrame] = useState<Frame | null>(null);
  const [frameSid, setFrameSid] = useState(sid);
  const videoRef = useRef<HTMLVideoElement>(null);
  const reportedAspect = useRef<number | null>(null);

  if (frameSid !== sid) {
    setFrameSid(sid);
    setFrame(null);
  }

  const frameChanged = useEffectEvent((next: number) => onFrameChange?.(next));
  const track = publication.track;

  // A share always arrives whole. With adaptive stream on (app/r/[id]/page.tsx) the room asks for a picture the size of
  // its element, but this one is zoomed by a CSS transform and the frame takes its size from the picture: the smaller
  // layer would blur the zoom and halve the frame. An explicit size cannot raise what adaptive stream asks for, so the
  // track is told about a viewer as large as the share itself.
  useEffect(() => {
    if (!(track instanceof RemoteVideoTrack) || !track.isAdaptiveStream) return;
    const pin: ElementInfo = {
      element: {}, visible: true, pictureInPicture: false, visibilityChangedAt: 0,
      width: () => publication.dimensions?.width || FULL_SIZE, height: () => publication.dimensions?.height || FULL_SIZE,
      observe() {}, stopObserving() {},
    };
    track.observeElementInfo(pin);
    return () => track.stopObservingElementInfo(pin);
  }, [track, publication]);

  useEffect(() => {
    const video = videoRef.current;
    const win = video?.ownerDocument.defaultView;
    if (!video || !win) return;
    let exact = false;
    const commit = (next: Frame) => {
      setFrame((previous) => previous && previous.width === next.width && previous.height === next.height && previous.source === next.source ? previous : next);
      const nextAspect = next.width / next.height;
      if (reportedAspect.current === nextAspect) return;
      reportedAspect.current = nextAspect;
      frameChanged(nextAspect);
    };
    const read = () => {
      const width = video.videoWidth, height = video.videoHeight;
      const expected = publication.track?.mediaStreamTrack;
      const stream = video.srcObject;
      const attached = stream && "getVideoTracks" in stream ? stream.getVideoTracks()[0] : undefined;
      if (!width || !height || !expected || attached?.id !== expected.id) return;
      exact = true;
      commit({ width, height, source: "video" });
    };
    video.addEventListener("loadedmetadata", read);
    video.addEventListener("resize", read);
    const raf = win.requestAnimationFrame(read);
    const timer = win.setTimeout(() => {
      if (exact) return;
      const next = provisionalFrame(publication);
      if (next) commit(next);
    }, PROVISIONAL_MS);
    return () => {
      video.removeEventListener("loadedmetadata", read);
      video.removeEventListener("resize", read);
      win.cancelAnimationFrame(raf);
      win.clearTimeout(timer);
    };
  }, [publication]);

  return <ZoomFrame frame={frame} className={className} frameless={frameless} zoomable={zoomable} interaction={interaction} fingersDraw={fingersDraw} resetKey={resetKey}
    media={<VideoTrack ref={videoRef} trackRef={trackRef} className={`absolute inset-0 h-full w-full ${frame?.source === "video" ? "object-fill" : "object-contain"} ${hideVideo ? "opacity-0" : ""}`} />}>
    {children}
  </ZoomFrame>;
}
