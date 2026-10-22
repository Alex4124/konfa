"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { CalendarDays, Copy, Play, Users, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
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
    const initial = window.setTimeout(() => void refresh().catch((cause) => setError(cause.message)), 0);
    const timer = window.setInterval(() => { void refresh().catch(() => {}); }, 5000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
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
    try { await navigator.clipboard.writeText(schedule.guestUrl); setCopied(true); window.setTimeout(() => setCopied(false), 2000); }
    catch { setError("Не удалось скопировать ссылку"); }
  }

  const when = schedule?.nextStartAt ? new Date(schedule.nextStartAt).toLocaleString("ru-RU", { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }) : null;
  return <main className="flex min-h-dvh items-start justify-center bg-background px-5 pb-10 pt-[max(2.5rem,10dvh)] text-foreground">
    <div className="w-full max-w-xl rounded-[28px] border border-border bg-card p-7 text-center shadow-2xl sm:p-10">
      {/* A full page load, like the app's other internal links (c4df779). */}
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <div className="flex items-center justify-between gap-3"><a href="/" className="inline-flex items-center gap-2 text-xl font-bold"><span className="brand-mark !h-9 !w-9"><Video size={18} /></span>конфа<span className="text-[var(--teal-text)]">.</span></a><ThemeToggle compact /></div>
      <div className="mx-auto mt-9 grid h-16 w-16 place-items-center rounded-2xl bg-primary/15 text-[var(--teal-text)]">{schedule?.kind === "webinar" ? <Users size={30} /> : <CalendarDays size={30} />}</div>
      <p className={`mt-6 text-xs font-semibold uppercase tracking-[.16em] text-[var(--teal-text)] ${schedule ? "" : "invisible"}`}>{schedule?.kind === "webinar" ? "Вебинар" : "Встреча"}</p>
      <h1 className="mt-2 break-words text-3xl font-semibold tracking-tight">{schedule?.title || (error ? "Конференция недоступна" : "Загружаем конференцию…")}</h1>
      {schedule && <><p className="mt-5 text-lg text-foreground">{schedule.activeRoomId ? "Конференция уже идёт. Перенаправляем…" : schedule.status === "cancelled" ? "Будущие сеансы отменены" : schedule.completed ? "Эта конференция завершена" : "Ведущий ещё не начал конференцию"}</p>
        {when && <p className="mt-3 text-sm text-[var(--text-subtle)]">Ближайшее время: <strong className="font-medium text-foreground">{when}</strong></p>}
        <p className="mt-2 text-xs text-muted-foreground">Время показано в вашем часовом поясе. Ведущий может начать встречу раньше или позже.</p>
        <div className="mt-7 flex flex-wrap justify-center gap-3"><Button variant="outline" className="min-w-52 border-border bg-transparent text-foreground hover:bg-accent hover:text-foreground" onClick={() => void copy()}><Copy size={16} />{copied ? "Скопировано" : "Скопировать ссылку"}</Button>{schedule.isOwner && schedule.status === "active" && !schedule.completed && <Button disabled={busy} onClick={() => void start()} className="bg-primary text-primary-foreground hover:bg-[var(--primary-hover)]"><Play size={16} />{busy ? "Запускаем…" : "Начать сейчас"}</Button>}</div>
        {schedule.isOwner ? <a href="/dashboard" className="mt-7 inline-block text-sm text-[var(--teal-text)] hover:underline">Управлять в кабинете</a> : <a href="/account" className="mt-7 inline-block text-sm text-muted-foreground hover:text-foreground">Войти в аккаунт ведущего</a>}
      </>}
      {error && <p role="alert" className="mt-6 text-sm text-[var(--danger-text)]">{error}</p>}
    </div>
  </main>;
}
