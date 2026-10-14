"use client";

import { useEffect, useState } from "react";
import { countCameras } from "@/lib/camera-facing";

// How many cameras the device has, counted only while `active`. Before the camera permission a phone lists one unnamed
// camera, so the caller turns this on once a camera is actually running. Not LiveKit's useMediaDevices: that one asks
// for the camera itself.
export function useCameraCount(active: boolean): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const media = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
    if (!active || typeof media?.enumerateDevices !== "function") return;
    let current = true;
    const read = () => {
      media.enumerateDevices().then(
        (devices) => { if (current) setCount(countCameras(devices)); },
        () => { if (current) setCount(0); },
      );
    };
    read();
    media.addEventListener("devicechange", read);
    return () => { current = false; media.removeEventListener("devicechange", read); };
  }, [active]);
  return active ? count : 0;
}
