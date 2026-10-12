"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { CalendarDays, Copy, Play, Users, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ScheduleView } from "@/lib/confa-types";

export default function SeriesPage() {
  const id = String(useParams().id || "");
  const [schedule, setSchedule] = useState<ScheduleView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    const response = await fetch(`/api/schedules/${id}`, { cache: "no-store" });
    const data = await response.json() as { schedule?: ScheduleView; error?: string };
    if (!response.ok || !data.schedule) throw new Error(data.error || "Конференция не найдена");
    setSchedule(data.schedule);
    if (data.schedule.activeRoomId) window.location.replace(`/r/${data.schedule.activeRoomId}`);
  }, [id]);

  useEffect(() => {
    void refresh().catch((cause) => setError(cause.message));
    const timer = window.setInterval(() => { void refresh().catch(() => {}); }, 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function start() {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/schedules/${id}/start`, { method: "POST" });
      const data = await response.json() as { roomUrl?: string; error?: string };
      if (!response.ok || !data.roomUrl) throw new Error(data.error || "Не удалось начать конференцию");
      window.location.assign(data.roomUrl);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось начать конференцию"); setBusy(false); }
  }

  async function copy() {
    if (!schedule) return;
    try { await navigator.clipboard.writeText(schedule.guestUrl); setCopied(true); }
    catch { setError("Не удалось скопировать ссылку"); }
  }

  const when = schedule?.nextStartAt ? new Date(schedule.nextStartAt).toLocaleString("ru-RU", { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }) : null;
  return <main className="grid min-h-dvh place-items-center bg-[#0e192c] px-5 py-10 text-white">
    <div className="w-full max-w-xl rounded-[28px] border border-white/10 bg-[#17263e] p-7 text-center shadow-2xl sm:p-10">
      <Link href="/" className="inline-flex items-center gap-2 text-xl font-bold"><span className="brand-mark !h-9 !w-9"><Video size={18} /></span>конфа<span className="text-[#6de7d4]">.</span></Link>
      <div className="mx-auto mt-9 grid h-16 w-16 place-items-center rounded-2xl bg-[#6de7d4]/15 text-[#6de7d4]">{schedule?.kind === "webinar" ? <Users size={30} /> : <CalendarDays size={30} />}</div>
      <p className="mt-6 text-xs font-semibold uppercase tracking-[.16em] text-[#6de7d4]">{schedule?.kind === "webinar" ? "Вебинар" : "Встреча"}</p>
      <h1 className="mt-2 break-words text-3xl font-semibold tracking-tight">{schedule?.title || (error ? "Конференция недоступна" : "Загружаем конференцию…")}</h1>
      {schedule && <><p className="mt-5 text-lg text-slate-200">{schedule.activeRoomId ? "Конференция уже идёт. Перенаправляем…" : schedule.status === "cancelled" ? "Будущие сеансы отменены" : schedule.completed ? "Эта конференция завершена" : "Ведущий ещё не начал конференцию"}</p>
        {when && <p className="mt-3 text-sm text-slate-300">Ближайшее время: <strong className="font-medium text-white">{when}</strong></p>}
        <p className="mt-2 text-xs text-slate-400">Время показано в вашем часовом поясе. Ведущий может начать встречу раньше или позже.</p>
        <div className="mt-7 flex flex-wrap justify-center gap-3"><Button variant="outline" className="border-white/20 bg-transparent text-white" onClick={() => void copy()}><Copy size={16} />{copied ? "Скопировано" : "Скопировать ссылку"}</Button>{schedule.isOwner && schedule.status === "active" && !schedule.completed && <Button disabled={busy} onClick={() => void start()} className="bg-[#6de7d4] text-[#10243a] hover:bg-[#96f5e7]"><Play size={16} />{busy ? "Запускаем…" : "Начать сейчас"}</Button>}</div>
        {schedule.isOwner ? <Link href="/dashboard" className="mt-7 inline-block text-sm text-[#9af4e7] hover:underline">Управлять в кабинете</Link> : <Link href="/account" className="mt-7 inline-block text-sm text-slate-400 hover:text-white">Войти в аккаунт ведущего</Link>}
      </>}
      {error && <p role="alert" className="mt-6 text-sm text-rose-300">{error}</p>}
    </div>
  </main>;
}
