"use client";

import { useEffect } from "react";
import { ThemeProvider, useTheme } from "next-themes";

function BrowserThemeColor() {
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (meta) meta.content = resolvedTheme === "dark" ? "#0e192c" : "#f5f8fb";
  }, [resolvedTheme]);

  return null;
}

export function AppThemeProvider({ children }: { children: React.ReactNode }) {
  return <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false} enableColorScheme storageKey="confa-theme" disableTransitionOnChange>
    <BrowserThemeColor />
    {children}
  </ThemeProvider>;
}
