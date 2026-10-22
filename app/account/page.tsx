"use client";

import { useEffect, useState, type FormEvent } from "react";
import { ArrowLeft, CalendarDays, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";

export default function AccountPage() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [name, setName] = useState("");
  const [nickname, setNickname] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/account").then((response) => response.json() as Promise<{ account?: unknown }>).then((data) => {
      if (data.account) window.location.replace("/dashboard");
    }).catch(() => {});
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/account", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: mode, name, nickname, email, password }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "Не удалось войти");
      window.location.assign("/dashboard");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось войти"); }
    finally { setBusy(false); }
  }

  return <main className="min-h-dvh bg-background px-5 py-7 text-foreground">
    <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
      {/* A full page load, like the app's other internal links (c4df779). */}
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a href="/" className="inline-flex items-center gap-2 text-sm text-[var(--text-subtle)] hover:text-foreground"><ArrowLeft size={17} /> На главную</a>
      <ThemeToggle compact />
    </div>
    <div className="mx-auto mt-8 grid max-w-5xl gap-8 sm:mt-12 sm:gap-10 lg:grid-cols-[1fr_430px] lg:items-start lg:pt-8">
      <section className="max-w-lg">
        <div className="mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground max-sm:hidden"><CalendarDays size={27} /></div>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-5xl">Планируйте встречи<br /><span className="text-[var(--teal-text)]">в своём ритме.</span></h1>
        <p className="mt-4 text-base leading-relaxed text-[var(--text-subtle)] sm:mt-5 sm:text-lg">Создавайте расписание встреч и вебинаров, выбирайте дни повторения и делитесь одной ссылкой на всю серию.</p>
        <p className="mt-7 flex items-center gap-2 text-sm text-muted-foreground"><Video size={17} /> Для обычной конференции аккаунт не нужен.</p>
      </section>
      <section className="w-full max-w-lg rounded-[28px] border border-border bg-card p-5 shadow-2xl sm:p-8 lg:max-w-none">
        <div className="mb-6 flex rounded-xl bg-background p-1" role="tablist" aria-label="Вход или регистрация">
          <button type="button" role="tab" aria-selected={mode === "login"} className={`flex-auto whitespace-nowrap rounded-lg px-3 py-2.5 text-sm font-medium ${mode === "login" ? "bg-[var(--control)] text-foreground" : "text-muted-foreground"}`} onClick={() => { setMode("login"); setError(""); }}>Войти</button>
          <button type="button" role="tab" aria-selected={mode === "register"} className={`flex-auto whitespace-nowrap rounded-lg px-3 py-2.5 text-sm font-medium ${mode === "register" ? "bg-[var(--control)] text-foreground" : "text-muted-foreground"}`} onClick={() => { setMode("register"); setError(""); }}>Создать аккаунт</button>
        </div>
        <h2 className="text-2xl font-semibold">{mode === "login" ? "С возвращением" : "Ваш аккаунт"}</h2>
        <form className="mt-6 space-y-4" onSubmit={(event) => void submit(event)}>
          {mode === "register" && <label className="block text-sm text-foreground">Имя<input required autoComplete="name" maxLength={60} value={name} onChange={(event) => setName(event.target.value)} className="mt-2 h-12 w-full rounded-xl border border-border bg-background px-4 text-base outline-none focus:border-primary" placeholder="Как к вам обращаться" /></label>}
          <label className="block text-sm text-foreground">Никнейм<input required autoComplete="username" minLength={3} maxLength={30} value={nickname} onChange={(event) => setNickname(event.target.value)} className="mt-2 h-12 w-full rounded-xl border border-border bg-background px-4 text-base outline-none focus:border-primary" placeholder="Ваш никнейм" /></label>
          {mode === "register" && <label className="block text-sm text-foreground">Email<input required type="email" autoComplete="email" maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} className="mt-2 h-12 w-full rounded-xl border border-border bg-background px-4 text-base outline-none focus:border-primary" placeholder="you@example.com" /></label>}
          <label className="block text-sm text-foreground">Пароль<input required type="password" autoComplete={mode === "register" ? "new-password" : "current-password"} minLength={mode === "register" ? 8 : undefined} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} className="mt-2 h-12 w-full rounded-xl border border-border bg-background px-4 text-base outline-none focus:border-primary" placeholder={mode === "register" ? "Не менее 8 символов" : "Ваш пароль"} /></label>
          {mode === "register" && <p className="text-xs leading-relaxed text-[var(--warning-text)]">Пока восстановление пароля по email недоступно. Сохраните пароль: забытый пароль сейчас нельзя сбросить.</p>}
          {error && <p role="alert" className="text-sm text-[var(--danger-text)]">{error}</p>}
          <Button type="submit" disabled={busy} className="h-12 w-full rounded-xl bg-primary text-base font-semibold text-primary-foreground hover:bg-[var(--primary-hover)]">{busy ? "Подождите…" : mode === "login" ? "Войти" : "Зарегистрироваться"}</Button>
        </form>
      </section>
    </div>
  </main>;
}
