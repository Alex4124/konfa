"use client";

import { useEffect, useState } from "react";
import { Mic, MonitorUp, Video, Users, PenLine } from "lucide-react";
import { Button } from "@/components/ui/button";

type RoomKind = "meeting" | "webinar";

export default function Home() {
  const [busy, setBusy] = useState<RoomKind | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    type WebMcpTool = { name: string; title: string; description: string; inputSchema: object; annotations: { readOnlyHint: boolean }; execute: (input: unknown) => Promise<unknown> };
    const context = (document as Document & { modelContext?: { registerTool: (tool: WebMcpTool, options?: { signal?: AbortSignal }) => void | Promise<void> } }).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    void Promise.resolve(context.registerTool({
      name: "create_video_room",
      title: "Создать видеокомнату",
      description: "Создать встречу или вебинар и открыть комнату ведущего.",
      inputSchema: { type: "object", properties: { kind: { type: "string", enum: ["meeting", "webinar"] } }, required: ["kind"], additionalProperties: false },
      annotations: { readOnlyHint: false },
      async execute(input) {
        const kind = (input as { kind?: unknown } | null)?.kind;
        if (kind !== "meeting" && kind !== "webinar") throw new Error("Выберите meeting или webinar");
        const response = await fetch("/api/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind }) });
        const result = await response.json() as { error?: string; hostUrl?: string };
        if (!response.ok || !result.hostUrl) throw new Error(result.error || "Не удалось создать комнату");
        window.location.assign(result.hostUrl);
        return { hostUrl: result.hostUrl };
      },
    }, { signal: lifecycle.signal })).catch(console.error);
    return () => lifecycle.abort();
  }, []);

  async function createRoom(kind: RoomKind) {
    setBusy(kind);
    setError("");
    try {
      const response = await fetch("/api/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind }) });
      const result = await response.json() as { error?: string; hostUrl: string };
      if (!response.ok) throw new Error(result.error || "Не удалось создать комнату");
      window.location.assign(result.hostUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось создать комнату");
      setBusy(null);
    }
  }

  return (
    <main className="home-shell min-h-screen text-white">
      <header className="mx-auto flex w-full max-w-7xl items-center justify-between px-6 py-7 lg:px-12">
        <div className="flex items-center gap-3" aria-label="Конфа"><span className="brand-mark"><Video size={21} strokeWidth={2.5} /></span><span className="text-xl font-bold tracking-tight">конфа<span className="text-[#6de7d4]">.</span></span></div>
        <span className="hidden rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-300 sm:inline-flex">Встречи и вебинары до 50 человек</span>
      </header>
      <div className="mx-auto grid max-w-7xl gap-10 px-6 pb-16 pt-10 xl:min-h-[calc(100vh-108px)] xl:grid-cols-[minmax(0,1fr)_minmax(400px,.9fr)] xl:items-center xl:gap-16 xl:px-12 xl:pb-28 xl:pt-0">
        <section className="min-w-0 max-w-2xl">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-[#6de7d4]/30 bg-[#6de7d4]/10 px-3 py-1.5 text-sm font-medium text-[#8ff4e4]"><span className="h-1.5 w-1.5 rounded-full bg-[#6de7d4]" />Пространство для разговора</div>
          <h1 className="max-w-xl text-[clamp(2.65rem,6vw,5rem)] font-semibold leading-[1.02] tracking-[-.055em]">Встречайтесь.<br /><span className="text-[#6de7d4]">Общайтесь.</span><br />Вместе.</h1>
          <p className="mt-7 max-w-lg text-lg leading-relaxed text-slate-300">Видеосвязь, вебинары и живые пометки прямо поверх общего экрана. Создайте комнату и пригласите людей по ссылке.</p>
          <div className="mt-10 flex flex-wrap gap-3">
            <Button className="h-13 rounded-xl bg-[#6de7d4] px-6 text-base font-semibold text-[#10243a] hover:bg-[#96f5e7]" disabled={busy !== null} onClick={() => createRoom("meeting")}><Video />{busy === "meeting" ? "Создаём…" : "Новая встреча"}</Button>
            <Button variant="outline" className="h-13 rounded-xl border-white/20 bg-white/5 px-6 text-base text-white hover:bg-white/10 hover:text-white" disabled={busy !== null} onClick={() => createRoom("webinar")}><Users />{busy === "webinar" ? "Создаём…" : "Новый вебинар"}</Button>
          </div>
          {error && <p role="alert" className="mt-4 text-sm text-rose-300">{error}</p>}
          <p className="mt-5 text-sm text-slate-400">Участникам не нужна регистрация</p>
        </section>
        <section aria-label="Возможности комнаты" className="room-preview rounded-[28px] border border-white/10 bg-[#17263e] p-4 shadow-[0_32px_90px_rgba(3,10,27,.35)] sm:p-5">
          <div className="mb-4 flex items-center justify-between px-1 text-sm text-slate-300"><span className="flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-[#6de7d4]" />Комната «Обсуждение проекта»</span><span className="flex items-center gap-1"><Users size={15} /> 4</span></div>
          <div className="relative aspect-[1.35] overflow-hidden rounded-2xl bg-[#253b59] p-5 sm:p-7">
            <div className="flex h-full flex-col justify-between rounded-xl border border-dashed border-white/20 bg-[#213953]/80 p-5 sm:p-7">
              <div className="flex items-center gap-2 text-xs uppercase tracking-[.18em] text-[#91a9c3]"><MonitorUp size={16} /> Демонстрация экрана</div>
              <div className="space-y-3"><div className="h-3 w-28 rounded-full bg-[#6de7d4]/80" /><div className="h-6 w-4/5 rounded bg-white/15" /><div className="h-6 w-3/5 rounded bg-white/10" /><div className="mt-5 grid grid-cols-3 gap-3"><div className="h-14 rounded-lg bg-[#6de7d4]/15" /><div className="h-14 rounded-lg bg-white/10" /><div className="h-14 rounded-lg bg-white/10" /></div></div>
            </div>
            <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 500 360" preserveAspectRatio="none" aria-hidden="true"><path d="M123 192 C185 121 257 130 322 174" fill="none" stroke="#88eadb" strokeWidth="5" strokeLinecap="round" /><path d="M307 155 L326 175 L302 185" fill="none" stroke="#88eadb" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" /><ellipse cx="360" cy="250" rx="60" ry="27" fill="none" stroke="#fbd38a" strokeWidth="5" transform="rotate(-8 360 250)" /></svg>
            <div className="absolute bottom-4 left-4 flex items-center gap-2 rounded-xl border border-white/15 bg-[#15253a]/90 px-3 py-2 text-xs text-white shadow-xl"><PenLine size={15} className="text-[#6de7d4]" /> Пометки видны всем</div>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-3">{["Анна","Михаил","Елена"].map((name) => <div key={name} className="preview-tile"><span>{name[0]}</span><small>{name}</small></div>)}</div>
          <div className="mt-4 flex items-center justify-center gap-3 border-t border-white/10 pt-4"><span className="preview-control"><Mic size={18} /></span><span className="preview-control"><Video size={18} /></span><span className="preview-control bg-[#6de7d4]/15 text-[#6de7d4]"><MonitorUp size={18} /></span><span className="ml-1 rounded-full bg-rose-400/20 px-4 py-2 text-xs font-medium text-rose-200">Завершить</span></div>
        </section>
      </div>
    </main>
  );
}
