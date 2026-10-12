"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, CalendarDays, Video } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function AccountPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [name, setName] = useState("");
  const [nickname, setNickname] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/account").then((response) => response.json() as Promise<{ account?: unknown }>).then((data) => {
      if (data.account) router.replace("/dashboard");
    }).catch(() => {});
  }, [router]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/account", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: mode, name, nickname, email, password }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "Не удалось войти");
      router.push("/dashboard");
      router.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось войти"); }
    finally { setBusy(false); }
  }

  return <main className="min-h-dvh bg-[#0e192c] px-5 py-7 text-white">
    <div className="mx-auto max-w-5xl"><Link href="/" className="inline-flex items-center gap-2 text-sm text-slate-300 hover:text-white"><ArrowLeft size={17} /> На главную</Link></div>
    <div className="mx-auto mt-12 grid max-w-5xl gap-10 lg:grid-cols-[1fr_430px] lg:items-center">
      <section className="max-w-lg">
        <div className="mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-[#6de7d4] text-[#10243a]"><CalendarDays size={27} /></div>
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">Планируйте встречи<br /><span className="text-[#6de7d4]">в своём ритме.</span></h1>
        <p className="mt-5 text-lg leading-relaxed text-slate-300">Создавайте расписание встреч и вебинаров, выбирайте дни повторения и делитесь одной ссылкой на всю серию.</p>
        <p className="mt-7 flex items-center gap-2 text-sm text-slate-400"><Video size={17} /> Для обычной конференции аккаунт не нужен.</p>
      </section>
      <section className="rounded-[28px] border border-white/10 bg-[#17263e] p-6 shadow-2xl sm:p-8">
        <div className="mb-6 flex rounded-xl bg-[#0e192c] p-1" role="tablist" aria-label="Вход или регистрация">
          <button type="button" role="tab" aria-selected={mode === "login"} className={`flex-1 rounded-lg px-3 py-2.5 text-sm font-medium ${mode === "login" ? "bg-[#2d415d] text-white" : "text-slate-400"}`} onClick={() => { setMode("login"); setError(""); }}>Войти</button>
          <button type="button" role="tab" aria-selected={mode === "register"} className={`flex-1 rounded-lg px-3 py-2.5 text-sm font-medium ${mode === "register" ? "bg-[#2d415d] text-white" : "text-slate-400"}`} onClick={() => { setMode("register"); setError(""); }}>Создать аккаунт</button>
        </div>
        <h2 className="text-2xl font-semibold">{mode === "login" ? "С возвращением" : "Ваш аккаунт"}</h2>
        <form className="mt-6 space-y-4" onSubmit={(event) => void submit(event)}>
          {mode === "register" && <label className="block text-sm text-slate-200">Имя<input required autoComplete="name" maxLength={60} value={name} onChange={(event) => setName(event.target.value)} className="mt-2 h-12 w-full rounded-xl border border-white/15 bg-[#0e192c] px-4 text-base outline-none focus:border-[#6de7d4]" placeholder="Как к вам обращаться" /></label>}
          <label className="block text-sm text-slate-200">Никнейм<input required autoComplete="username" minLength={3} maxLength={30} value={nickname} onChange={(event) => setNickname(event.target.value)} className="mt-2 h-12 w-full rounded-xl border border-white/15 bg-[#0e192c] px-4 text-base outline-none focus:border-[#6de7d4]" placeholder="Ваш никнейм" /></label>
          {mode === "register" && <label className="block text-sm text-slate-200">Email<input required type="email" autoComplete="email" maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} className="mt-2 h-12 w-full rounded-xl border border-white/15 bg-[#0e192c] px-4 text-base outline-none focus:border-[#6de7d4]" placeholder="you@example.com" /></label>}
          <label className="block text-sm text-slate-200">Пароль<input required type="password" autoComplete={mode === "register" ? "new-password" : "current-password"} minLength={mode === "register" ? 8 : undefined} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} className="mt-2 h-12 w-full rounded-xl border border-white/15 bg-[#0e192c] px-4 text-base outline-none focus:border-[#6de7d4]" placeholder={mode === "register" ? "Не менее 8 символов" : "Ваш пароль"} /></label>
          {mode === "register" && <p className="text-xs leading-relaxed text-amber-200">Пока восстановление пароля по email недоступно. Сохраните пароль: забытый пароль сейчас нельзя сбросить.</p>}
          {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
          <Button type="submit" disabled={busy} className="h-12 w-full rounded-xl bg-[#6de7d4] text-base font-semibold text-[#10243a] hover:bg-[#96f5e7]">{busy ? "Подождите…" : mode === "login" ? "Войти" : "Зарегистрироваться"}</Button>
        </form>
      </section>
    </div>
  </main>;
}
