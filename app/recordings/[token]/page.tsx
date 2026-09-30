"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Download, Video } from "lucide-react";

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

  return <main className="min-h-screen bg-[#0e192c] px-5 py-8 text-white">
    <div className="mx-auto max-w-5xl"><Link href="/" className="inline-flex items-center gap-2 text-sm text-slate-300 hover:text-white"><ArrowLeft size={17} /> На главную</Link>
      <div className="mt-12 flex items-center gap-3"><span className="brand-mark"><Video size={20} /></span><h1 className="text-3xl font-semibold">Запись встречи</h1></div>
      <p className="mt-3 text-slate-400">Ссылка действует 30 дней после завершения записи.</p>
      {error ? <div role="alert" className="mt-8 rounded-2xl border border-rose-400/25 bg-rose-400/10 p-6 text-rose-100">{error}</div>
        : status === "ready" ? <><video controls playsInline className="mt-8 aspect-video w-full rounded-2xl bg-black" src={`/api/recordings/${token}/file`} /><a href={`/api/recordings/${token}/file`} download className="mt-5 inline-flex items-center gap-2 rounded-xl bg-[#6de7d4] px-5 py-3 font-semibold text-[#10243a]"><Download size={18} /> Скачать видео</a></>
        : <div className="mt-8 grid aspect-video place-items-center rounded-2xl border border-white/10 bg-[#17263e] text-center text-slate-300">{status === "failed" ? "Запись не удалась" : status === "recording" ? "Запись ещё идёт" : "Подготавливаем видео…"}</div>}
    </div>
  </main>;
}
