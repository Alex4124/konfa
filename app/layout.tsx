import type { Metadata, Viewport } from "next";
import { AppThemeProvider } from "@/components/theme-provider";
import { LEGACY_BROWSER_SCRIPT } from "@/lib/legacy-browser";
import "./globals.css";

export const metadata: Metadata = {
  title: "Конфа — видеовстречи и вебинары",
  description: "Видеовстречи и вебинары с совместными пометками на экране.",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", interactiveWidget: "resizes-content", themeColor: "#f5f8fb" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // The inline script must run before the app's modules: it fills in what older browsers lack (lib/legacy-browser.ts).
  return <html lang="ru" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{ __html: LEGACY_BROWSER_SCRIPT }} /></head><body className="antialiased"><AppThemeProvider>{children}</AppThemeProvider></body></html>;
}
