"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { ArrowLeft, Download, Video } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";

export default function RecordingPage() {
  const params = useParams();
  const token = String(params.token || "");
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch(`/api/recordings/${token}`, { cache: "no-store" });
        const result = await response.json() as { error?: string; status: string };
        if (!response.ok) throw new Error(result.error || "Запись недоступна");
        if (active) setStatus(result.status);
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : "Запись недоступна"); }
    };
    void refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [token]);

  return <main className="min-h-dvh bg-background px-5 py-8 text-foreground">
    <div className="mx-auto max-w-5xl">
      {/* A full page load, like the app's other internal links (c4df779). */}
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <div className="flex items-center justify-between gap-3"><a href="/" className="inline-flex items-center gap-2 text-sm text-[var(--text-subtle)] hover:text-foreground"><ArrowLeft size={17} /> На главную</a><ThemeToggle compact /></div>
      <div className="mt-12 flex items-center gap-3"><span className="brand-mark"><Video size={20} /></span><h1 className="text-3xl font-semibold">Запись встречи</h1></div>
      <p className="mt-3 text-muted-foreground">Ссылка действует 30 дней после завершения записи.</p>
      {error ? <div role="alert" className="mt-8 rounded-2xl border border-rose-400/25 bg-rose-400/10 p-6 text-[var(--danger-text)]">{error}</div>
        : status === "ready" ? <><video controls playsInline className="mt-8 aspect-video w-full rounded-2xl bg-black" src={`/api/recordings/${token}/file`} /><a href={`/api/recordings/${token}/file`} download className="mt-5 inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-3 font-semibold text-primary-foreground"><Download size={18} /> Скачать видео</a></>
        : <div className="mt-8 grid aspect-video place-items-center rounded-2xl border border-border bg-card text-center text-[var(--text-subtle)]">{status === "failed" ? "Запись не удалась" : status === "recording" ? "Запись ещё идёт" : "Подготавливаем видео…"}</div>}
    </div>
  </main>;
}
