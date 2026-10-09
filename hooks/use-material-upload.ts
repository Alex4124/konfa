"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { UploadProgress } from "@/lib/document-upload";

export type MaterialUpload = { name: string; progress: UploadProgress | null };
type Options = {
  roomId: string;
  token: string;
  onUploaded(docId: string): Promise<unknown>; // opens the new material
  onError(message: string): void;
};

// The teacher's one upload at a time; it lives in the room, so collapsing the material or switching to the screen share keeps it going.
export function useMaterialUpload({ roomId, token, onUploaded, onError }: Options): { upload: MaterialUpload | null; start(file: File): void; cancel(): void } {
  const [upload, setUpload] = useState<MaterialUpload | null>(null);
  const controller = useRef<AbortController | null>(null);
  const latest = useRef({ onUploaded, onError });
  useEffect(() => { latest.current = { onUploaded, onError }; });
  useEffect(() => () => controller.current?.abort(), []);

  const start = useCallback((file: File) => {
    if (controller.current) return;
    const abort = new AbortController();
    controller.current = abort;
    setUpload({ name: file.name, progress: null });
    void (async () => {
      try {
        const { uploadDocument } = await import("@/lib/document-upload");
        const docId = await uploadDocument({
          file, roomId, token, signal: abort.signal,
          onProgress: (progress) => { if (!abort.signal.aborted) setUpload({ name: file.name, progress }); },
          confirmPages: (total, max) => window.confirm(`В файле ${total} страниц, а в материал помещается ${max}. Загрузить первые ${max}?`),
        });
        await latest.current.onUploaded(docId);
      } catch (cause) {
        const aborted = abort.signal.aborted || (cause instanceof DOMException && cause.name === "AbortError");
        if (!aborted) latest.current.onError(cause instanceof Error && cause.message ? cause.message : "Не удалось загрузить материал");
      } finally {
        if (controller.current === abort) controller.current = null;
        setUpload(null);
      }
    })();
  }, [roomId, token]);

  const cancel = useCallback(() => controller.current?.abort(), []);

  return { upload, start, cancel };
}
