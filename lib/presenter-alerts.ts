import type { AnnotationActivity } from "@/lib/annotation-sync";

export const ALERT_TITLE = "Новые пометки — Конфа";
export const ALERT_COUNT_CAP = 99;

type PluralForms = readonly [one: string, few: string, many: string];

function count(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// Russian plural form for n: 1, 21, 101 → one; 2-4, 22-24 → few; 0, 5-20, 25-30, 111-114 → many.
export function pluralRu(n: number, forms: PluralForms): string {
  const abs = Math.floor(Math.abs(Number.isFinite(n) ? n : 0));
  const tens = abs % 100;
  const ones = abs % 10;
  if (tens >= 11 && tens <= 14) return forms[2];
  if (ones === 1) return forms[0];
  if (ones >= 2 && ones <= 4) return forms[1];
  return forms[2];
}

// «1 новая пометка», «2 новые пометки», «5 новых пометок».
export function marksLabel(n: number): string {
  const value = count(n);
  return `${value} ${pluralRu(value, ["новая пометка", "новые пометки", "новых пометок"])}`;
}

// «1 пометка», «2 пометки», «5 пометок»: totals that are not new (moderation rows, the mirror placeholder).
export function marksCountLabel(n: number): string {
  const value = count(n);
  return `${value} ${pluralRu(value, ["пометка", "пометки", "пометок"])}`;
}

// «(3) Новые пометки — Конфа» while there is something unseen, otherwise the page's own title.
export function alertTitle(n: number, base: string): string {
  const value = count(n);
  if (!value) return base;
  return `(${value > ALERT_COUNT_CAP ? `${ALERT_COUNT_CAP}+` : value}) ${ALERT_TITLE}`;
}

// What bumps the counter: someone else's saved mark, or the start of their laser / fading-ink stroke (never saved).
export function isAlertActivity(activity: AnnotationActivity, selfId?: string | null): boolean {
  if (selfId && activity.authorId === selfId) return false;
  return activity.type === "mark" || activity.kind === "laser";
}
