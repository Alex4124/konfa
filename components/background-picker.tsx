"use client";

import { useRef, type ChangeEvent } from "react";
import { supportsBackgroundProcessors } from "@livekit/track-processors";
import { ImagePlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";

export type VideoBackground = { name: string; url: string };

const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const maxSize = 10 * 1024 * 1024;

export function BackgroundPicker({ background, onChange, onError, compact = false }: {
  background: VideoBackground | null;
  onChange: (background: VideoBackground | null) => void;
  onError: (message: string) => void;
  compact?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);

  async function pick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!supportsBackgroundProcessors()) {
      onError("Этот браузер не поддерживает замену фона");
      return;
    }
    if (!allowedTypes.has(file.type) || file.size > maxSize || file.size === 0) {
      onError("Загрузите JPG, PNG или WebP размером до 10 МБ");
      return;
    }
    try {
      const bitmap = await createImageBitmap(file);
      if (!bitmap.width || !bitmap.height) throw new Error("empty image");
      bitmap.close();
      onChange({ name: file.name, url: URL.createObjectURL(file) });
      onError("");
    } catch {
      onError("Не удалось открыть изображение фона");
    }
  }

  return <div className={`flex min-w-0 items-center gap-2 ${compact ? "" : "flex-wrap"}`}>
    <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" aria-label="Изображение фона" onChange={(event) => void pick(event)} />
    <Button type="button" variant="secondary" size="sm" title="Загрузить фон камеры" aria-label="Загрузить фон камеры" className="bg-[#2d415d] text-white hover:bg-[#3e5673]" onClick={() => input.current?.click()}><ImagePlus size={17} />{compact ? "Фон" : "Загрузить фон"}</Button>
    {background && <>
      <span className="h-8 w-8 shrink-0 rounded-md border border-white/20 bg-cover bg-center" style={{ backgroundImage: `url(${background.url})` }} aria-hidden="true" />
      {!compact && <span className="max-w-36 truncate text-xs text-slate-300" title={background.name}>{background.name}</span>}
      <Button type="button" variant="ghost" size="icon-sm" title="Убрать фон" aria-label="Убрать фон" className="text-slate-200 hover:bg-white/10 hover:text-white" onClick={() => onChange(null)}><X size={16} /></Button>
    </>}
  </div>;
}
