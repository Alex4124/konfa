"use client";

import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { VideoTrack } from "@livekit/components-react";

type TrackRef = NonNullable<ComponentProps<typeof VideoTrack>["trackRef"]>;

export function SharedScreen({ trackRef, children, className = "" }: { trackRef: TrackRef; children?: ReactNode; className?: string }) {
  const container = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState<{ width: number; height: number } | null>(null);
  const settings = trackRef.publication.track?.mediaStreamTrack?.getSettings();
  const ratio = settings?.width && settings?.height ? settings.width / settings.height : 16 / 9;

  useEffect(() => {
    if (!container.current) return;
    const update = () => {
      const rect = container.current?.getBoundingClientRect();
      if (!rect) return;
      const height = Math.min(rect.height, rect.width / ratio);
      setBounds({ width: Math.round(height * ratio), height: Math.round(height) });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container.current);
    return () => observer.disconnect();
  }, [ratio]);

  return <div ref={container} className={`relative flex h-full w-full items-center justify-center overflow-hidden ${className}`}>
    <div className="relative overflow-hidden rounded-lg bg-black" style={bounds ? { width: bounds.width, height: bounds.height } : { width: "100%", aspectRatio: ratio, maxHeight: "100%" }}>
      <VideoTrack trackRef={trackRef} className="absolute inset-0 h-full w-full object-contain" />
      {children}
    </div>
  </div>;
}
