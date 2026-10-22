import type { Metadata, Viewport } from "next";
import { AppThemeProvider } from "@/components/theme-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Конфа — видеовстречи и вебинары",
  description: "Видеовстречи и вебинары с совместными пометками на экране.",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", interactiveWidget: "resizes-content", themeColor: "#f5f8fb" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru" suppressHydrationWarning><body className="antialiased"><AppThemeProvider>{children}</AppThemeProvider></body></html>;
}
