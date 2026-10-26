// A wrong or outdated address. Replaces vinext's English "404: This page could not be found."
export const metadata = { title: "Страница не найдена — Конфа" };

export default function NotFound() {
  return <main className="grid min-h-dvh place-items-center px-5 py-10">
    <div className="max-w-md text-center">
      <p className="text-sm font-medium uppercase tracking-[.14em] text-muted-foreground">Ошибка 404</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">Страница не найдена</h1>
      <p className="mt-3 text-muted-foreground">Проверьте ссылку или попросите ведущего прислать её ещё раз.</p>
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a href="/" className="mt-6 inline-flex h-11 items-center rounded-xl bg-primary px-5 font-semibold text-primary-foreground hover:bg-[var(--primary-hover)]">На главную</a>
    </div>
  </main>;
}
