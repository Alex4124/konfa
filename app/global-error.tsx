"use client";

import { useEffect } from "react";

// Shown when the page's own code fails to start: a chunk that did not load (bad connection) or did not run (an old
// browser). It replaces vinext's English "This page couldn't load", so it carries its own markup and styles and imports
// nothing heavy.
const CSS = `
:root { --bg: #f5f8fb; --fg: #12263b; --muted: #526779; --btn: #12263b; --btn-text: #ffffff; --line: #d4dee7; }
@media (prefers-color-scheme: dark) { :root { --bg: #0e192c; --fg: #f7fafc; --muted: #aabbd0; --btn: #6de7d4; --btn-text: #10243a; --line: #34496a; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 -apple-system, system-ui, "Segoe UI", Roboto, Arial, sans-serif; }
main { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 32px 20px; box-sizing: border-box; }
.card { max-width: 440px; }
h1 { margin: 0 0 12px; font-size: 26px; line-height: 1.25; font-weight: 600; }
p { margin: 0 0 12px; color: var(--muted); }
.actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 20px; }
button, a { display: inline-flex; align-items: center; height: 44px; padding: 0 18px; border-radius: 10px; font: inherit; font-weight: 600; text-decoration: none; cursor: pointer; box-sizing: border-box; }
button { border: 0; background: var(--btn); color: var(--btn-text); }
a { border: 1px solid var(--line); color: var(--fg); }
`;

type ReportError = (kind: string, message: unknown, source: unknown) => void;

export default function GlobalError({ error }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    (window as Window & { __konfaReportError?: ReportError }).__konfaReportError?.("boundary", error?.message, error?.digest || "");
  }, [error]);

  return <html lang="ru">
    <head><title>Страница не загрузилась — Конфа</title><style dangerouslySetInnerHTML={{ __html: CSS }} /></head>
    <body>
      <main>
        <div className="card" role="alert">
          <h1>Страница не загрузилась</h1>
          <p>Обновите страницу — обычно это помогает, если подвёл интернет.</p>
          <p>Если ошибка повторяется, браузер, скорее всего, устарел. На iPhone и iPad обновите систему (Настройки → Основные → Обновление ПО), на Android — Chrome или Яндекс Браузер. Или откройте ссылку на другом устройстве.</p>
          <div className="actions">
            <button type="button" onClick={() => window.location.reload()}>Обновить</button>
            {/* A plain link: client-side routing is what failed. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/">На главную</a>
          </div>
        </div>
      </main>
    </body>
  </html>;
}
