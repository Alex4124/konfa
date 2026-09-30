import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Конфа — видеовстречи и вебинары",
  description: "Видеовстречи и вебинары с совместными пометками на экране.",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru"><body className="antialiased">{children}</body></html>;
}
