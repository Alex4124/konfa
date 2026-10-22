"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

type Props = { className?: string; compact?: boolean };

export function ThemeToggle({ className = "", compact = false }: Props) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const dark = mounted && resolvedTheme === "dark";
  const label = dark ? "Включить светлую тему" : "Включить тёмную тему";

  return <button type="button" title={label} aria-label={label} aria-pressed={dark} onClick={() => setTheme(dark ? "light" : "dark")}
    className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-border bg-card px-3 text-sm font-medium text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${compact ? "min-w-10 px-2" : ""} ${className}`}>
    {dark ? <Sun size={17} aria-hidden /> : <Moon size={17} aria-hidden />}
    {!compact && <span>{dark ? "Светлая тема" : "Тёмная тема"}</span>}
  </button>;
}
