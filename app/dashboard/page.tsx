"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { CalendarDays, Copy, LogOut, Pencil, Play, Plus, Video, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { RoomKind, ScheduleView } from "@/lib/confa-types";

type Account = { id: string; name: string; nickname: string; email: string };
type FormState = { title: string; kind: RoomKind; startDate: string; startTime: string; durationMinutes: number; recurrence: ScheduleView["recurrence"]; weekdays: number; timezone: string };
const days = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

function localDate() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function emptyForm(): FormState {
  return { title: "", kind: "meeting", startDate: localDate(), startTime: "18:00", durationMinutes: 60, recurrence: "once", weekdays: 0, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" };
}

function describeRecurrence(schedule: ScheduleView): string {
  if (schedule.recurrence === "daily") return "Каждый день";
  if (schedule.recurrence === "weekly") return "Каждую неделю";
  if (schedule.recurrence === "weekdays") return days.filter((_, index) => schedule.weekdays & (1 << index)).join(", ");
  return "Один раз";
}

function localWhen(value: number): string {
  return new Date(value).toLocaleString("ru-RU", { weekday: "short", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
}

export default function DashboardPage() {
  const [account, setAccount] = useState<Account | null>(null);
  const [schedules, setSchedules] = useState<ScheduleView[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");

  const refresh = useCallback(async () => {
    const [accountResponse, schedulesResponse] = await Promise.all([fetch("/api/account"), fetch("/api/schedules")]);
    const accountData = await accountResponse.json() as { account: Account | null };
    if (!accountData.account || schedulesResponse.status === 401) { window.location.replace("/account"); return; }
    if (!schedulesResponse.ok) throw new Error("Не удалось загрузить расписание");
    const scheduleData = await schedulesResponse.json() as { schedules: ScheduleView[] };
    setAccount(accountData.account);
    setSchedules(scheduleData.schedules);
    setLoading(false);
  }, []);

  useEffect(() => { void refresh().catch((cause) => { setError(cause.message); setLoading(false); }); }, [refresh]);

  async function api(url: string, method: string, body?: unknown) {
    const response = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json() as { error?: string; roomUrl?: string };
    if (!response.ok) throw new Error(data.error || "Действие не выполнено");
    return data;
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!form) return;
    setBusy("save"); setError(""); setNotice("");
    try {
      await api(editingId ? `/api/schedules/${editingId}` : "/api/schedules", editingId ? "PATCH" : "POST", form);
      setForm(null); setEditingId(null);
      await refresh();
      setNotice(editingId ? "Расписание обновлено" : "Конференция запланирована");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось сохранить"); }
    finally { setBusy(""); }
  }

  function edit(schedule: ScheduleView) {
    setEditingId(schedule.id);
    setForm({ title: schedule.title, kind: schedule.kind, startDate: schedule.startDate, startTime: schedule.startTime, durationMinutes: schedule.durationMinutes, recurrence: schedule.recurrence, weekdays: schedule.weekdays, timezone: schedule.timezone });
    setError(""); setNotice("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function start(schedule: ScheduleView) {
    setBusy(schedule.id); setError("");
    try {
      const data = await api(`/api/schedules/${schedule.id}/start`, "POST");
      if (data.roomUrl) window.location.assign(data.roomUrl);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось начать конференцию"); setBusy(""); }
  }

  async function cancel(schedule: ScheduleView) {
    if (!window.confirm(`Отменить «${schedule.title}» и все будущие повторы?`)) return;
    setBusy(schedule.id); setError("");
    try { await api(`/api/schedules/${schedule.id}`, "DELETE"); await refresh(); setNotice("Конференция отменена"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось отменить"); }
    finally { setBusy(""); }
  }

  async function copy(url: string) {
    try { await navigator.clipboard.writeText(url); setNotice("Ссылка скопирована"); }
    catch { setError("Не удалось скопировать ссылку"); }
  }

  async function logout() {
    setBusy("logout");
    try { await api("/api/account", "POST", { action: "logout" }); window.location.assign("/"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось выйти"); setBusy(""); }
  }

  async function updatePassword(event: FormEvent) {
    event.preventDefault(); setBusy("password"); setError(""); setNotice("");
    try { await api("/api/account", "POST", { action: "password", currentPassword, newPassword }); setCurrentPassword(""); setNewPassword(""); setNotice("Пароль изменён. Остальные сеансы завершены."); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось изменить пароль"); }
    finally { setBusy(""); }
  }

  if (loading) return <main className="grid min-h-dvh place-items-center bg-[#0e192c] text-slate-300">Загружаем кабинет…</main>;
  return <main className="min-h-dvh bg-[#0e192c] text-white">
    <header className="border-b border-white/10 bg-[#14243a]"><div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-5 py-4">
      <a href="/" className="flex items-center gap-2 text-xl font-bold"><span className="brand-mark !h-9 !w-9"><Video size={18} /></span>конфа<span className="text-[#6de7d4]">.</span></a>
      <div className="flex items-center gap-3 text-sm"><span className="text-slate-300">{account?.name} <span className="text-slate-500">@{account?.nickname}</span></span><Button variant="ghost" size="sm" onClick={() => void logout()} disabled={busy === "logout"} className="text-slate-300 hover:text-white"><LogOut size={16} />Выйти</Button></div>
    </div></header>
    <div className="mx-auto max-w-6xl px-5 py-9 sm:py-12">
      <div className="flex flex-wrap items-end justify-between gap-5"><div><p className="text-sm font-medium text-[#6de7d4]">Личный кабинет</p><h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Ваши конференции</h1><p className="mt-3 text-slate-400">Планируйте встречи и делитесь постоянной ссылкой с участниками.</p></div><Button className="rounded-xl bg-[#6de7d4] text-[#10243a] hover:bg-[#96f5e7]" onClick={() => { setEditingId(null); setForm(emptyForm()); setError(""); }}><Plus size={17} />Запланировать</Button></div>
      {error && <p role="alert" className="mt-6 rounded-xl border border-rose-400/30 bg-rose-400/10 p-3 text-sm text-rose-200">{error}</p>}
      {notice && <p role="status" className="mt-6 rounded-xl border border-[#6de7d4]/30 bg-[#6de7d4]/10 p-3 text-sm text-[#9af4e7]">{notice}</p>}
      {form && <form onSubmit={(event) => void save(event)} className="mt-8 rounded-2xl border border-[#6de7d4]/30 bg-[#17263e] p-5 sm:p-7">
        <div className="mb-5 flex items-center justify-between"><h2 className="text-xl font-semibold">{editingId ? "Изменить расписание" : "Новая конференция"}</h2><button type="button" title="Закрыть" onClick={() => { setForm(null); setEditingId(null); }}><X size={19} /></button></div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <label className="text-sm text-slate-200 sm:col-span-2">Название<input required maxLength={100} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} className="mt-2 h-11 w-full rounded-xl border border-white/15 bg-[#0e192c] px-3 outline-none focus:border-[#6de7d4]" placeholder="Например, Еженедельный разбор" /></label>
          <label className="text-sm text-slate-200">Тип<select value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as RoomKind })} className="mt-2 h-11 w-full rounded-xl border border-white/15 bg-[#0e192c] px-3"><option value="meeting">Встреча</option><option value="webinar">Вебинар</option></select></label>
          <label className="text-sm text-slate-200">Длительность<select value={form.durationMinutes} onChange={(event) => setForm({ ...form, durationMinutes: Number(event.target.value) })} className="mt-2 h-11 w-full rounded-xl border border-white/15 bg-[#0e192c] px-3">{[15, 30, 45, 60, 90, 120, 180, 240, 480].map((minutes) => <option key={minutes} value={minutes}>{minutes < 60 ? `${minutes} мин` : `${minutes / 60} ч`}</option>)}</select></label>
          <label className="text-sm text-slate-200">Дата начала<input required type="date" value={form.startDate} onChange={(event) => setForm({ ...form, startDate: event.target.value })} className="mt-2 h-11 w-full rounded-xl border border-white/15 bg-[#0e192c] px-3" /></label>
          <label className="text-sm text-slate-200">Время начала<input required type="time" value={form.startTime} onChange={(event) => setForm({ ...form, startTime: event.target.value })} className="mt-2 h-11 w-full rounded-xl border border-white/15 bg-[#0e192c] px-3" /></label>
          <label className="text-sm text-slate-200 sm:col-span-2">Повторение<select value={form.recurrence} onChange={(event) => setForm({ ...form, recurrence: event.target.value as FormState["recurrence"] })} className="mt-2 h-11 w-full rounded-xl border border-white/15 bg-[#0e192c] px-3"><option value="once">Без повтора</option><option value="daily">Каждый день</option><option value="weekly">Каждую неделю</option><option value="weekdays">По выбранным дням недели</option></select></label>
        </div>
        {form.recurrence === "weekdays" && <fieldset className="mt-5"><legend className="text-sm text-slate-200">Дни недели</legend><div className="mt-2 flex flex-wrap gap-2">{days.map((day, index) => <button type="button" key={day} aria-pressed={Boolean(form.weekdays & (1 << index))} onClick={() => setForm({ ...form, weekdays: form.weekdays ^ (1 << index) })} className={`h-10 min-w-11 rounded-lg border px-3 text-sm ${form.weekdays & (1 << index) ? "border-[#6de7d4] bg-[#6de7d4]/20 text-[#9af4e7]" : "border-white/15 text-slate-300"}`}>{day}</button>)}</div></fieldset>}
        <p className="mt-4 text-xs text-slate-400">Часовой пояс серии: {form.timezone}. Участники увидят время в своём часовом поясе. Ведущий запускает и завершает звонок вручную.</p>
        <div className="mt-6 flex gap-3"><Button type="submit" disabled={busy === "save"} className="rounded-xl bg-[#6de7d4] text-[#10243a] hover:bg-[#96f5e7]">{busy === "save" ? "Сохраняем…" : "Сохранить"}</Button><Button type="button" variant="outline" className="rounded-xl border-white/20 bg-transparent text-white" onClick={() => { setForm(null); setEditingId(null); }}>Отмена</Button></div>
      </form>}
      <section className="mt-9 grid gap-4 md:grid-cols-2">
        {schedules.length === 0 && <div className="col-span-full rounded-2xl border border-dashed border-white/20 bg-[#17263e] p-10 text-center"><CalendarDays className="mx-auto text-[#6de7d4]" size={35} /><h2 className="mt-4 text-xl font-semibold">Пока нет запланированных конференций</h2><p className="mt-2 text-slate-400">Выберите дату и время, чтобы создать первую.</p></div>}
        {schedules.map((schedule) => <article key={schedule.id} className="rounded-2xl border border-white/10 bg-[#17263e] p-5 sm:p-6">
          <div className="flex items-start justify-between gap-3"><div className="flex min-w-0 items-start gap-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#6de7d4]/15 text-[#6de7d4]">{schedule.kind === "meeting" ? <Video size={19} /> : <Users size={19} />}</span><div><p className="text-xs font-medium uppercase tracking-wide text-[#6de7d4]">{schedule.kind === "meeting" ? "Встреча" : "Вебинар"}</p><h2 className="mt-1 break-words text-lg font-semibold">{schedule.title}</h2></div></div><span className="shrink-0 rounded-full bg-white/10 px-2.5 py-1 text-xs text-slate-300">{schedule.status === "cancelled" ? "Отменена" : schedule.completed ? "Завершена" : schedule.activeRoomId ? "Идёт" : "Запланирована"}</span></div>
          <p className="mt-5 text-sm text-slate-200">{schedule.nextStartAt ? `Следующая: ${localWhen(schedule.nextStartAt)}` : schedule.completed ? "Разовая конференция проведена" : schedule.status === "cancelled" ? "Будущие сеансы отменены" : "Ближайшее время не найдено"}</p>
          <p className="mt-1 text-xs text-slate-400">{describeRecurrence(schedule)} · {schedule.durationMinutes} мин · {schedule.timezone}</p>
          {schedule.missedAt.length > 0 && <p className="mt-2 text-xs text-amber-200">Пропущено за 30 дней: {schedule.missedAt.length}</p>}
          <div className="mt-5 flex flex-wrap gap-2"><a href={`/s/${schedule.id}`} className="inline-flex h-9 items-center rounded-lg border border-white/20 px-3 text-sm hover:bg-white/10">Открыть страницу</a><Button size="sm" variant="outline" className="border-white/20 bg-transparent text-white" onClick={() => void copy(schedule.guestUrl)}><Copy size={14} />Ссылка</Button>{schedule.status === "active" && !schedule.completed && <Button size="sm" className="bg-[#6de7d4] text-[#10243a] hover:bg-[#96f5e7]" disabled={busy === schedule.id} onClick={() => void start(schedule)}><Play size={14} />{schedule.activeRoomId ? "Войти" : "Начать сейчас"}</Button>}</div>
          {schedule.status === "active" && !schedule.completed && <div className="mt-4 flex gap-4 border-t border-white/10 pt-4 text-xs"><button type="button" className="inline-flex items-center gap-1 text-slate-300 hover:text-white" onClick={() => edit(schedule)}><Pencil size={13} />Изменить</button><button type="button" className="text-rose-300 hover:text-rose-200" onClick={() => void cancel(schedule)}>Отменить серию</button></div>}
        </article>)}
      </section>
      <section className="mt-12 max-w-lg rounded-2xl border border-white/10 bg-[#17263e] p-5 sm:p-6"><h2 className="text-lg font-semibold">Безопасность аккаунта</h2><p className="mt-1 text-sm text-slate-400">Email {account?.email} пока не подтверждён. Восстановление пароля ещё недоступно.</p><form className="mt-5 flex flex-col gap-3" onSubmit={(event) => void updatePassword(event)}><input type="password" required autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} placeholder="Текущий пароль" aria-label="Текущий пароль" className="h-11 rounded-xl border border-white/15 bg-[#0e192c] px-3" /><input type="password" required minLength={8} maxLength={128} autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="Новый пароль (от 8 символов)" aria-label="Новый пароль" className="h-11 rounded-xl border border-white/15 bg-[#0e192c] px-3" /><Button type="submit" disabled={busy === "password"} variant="outline" className="self-start border-white/20 bg-transparent text-white">Изменить пароль</Button></form></section>
    </div>
  </main>;
}
