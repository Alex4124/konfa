"use client";

import { useEffect, useMemo, useState } from "react";
import { Eraser } from "lucide-react";
import { Button } from "@/components/ui/button";
import { authorLabel } from "@/components/annotations/author-chip";
import { useBoard, type AnnotationSync } from "@/hooks/use-annotation-sync";
import { marksCountLabel } from "@/lib/presenter-alerts";

type Props = {
  sync: AnnotationSync;
  shareId: string;
  authorId: string;
  canModerate: boolean; // host or the share owner: may erase everyone's marks
};

const CONFIRM_MS = 4000;

// A participant row's marks on the current share: «3 пометки» and, for moderators, «Стереть пометки участника» confirmed in place (no window.confirm).
export function AuthorMarks({ sync, shareId, authorId, canModerate }: Props) {
  const board = useBoard(sync.store);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const count = useMemo(() => board.shareId === shareId ? board.items.reduce((total, item) => item.authorId === authorId ? total + 1 : total, 0) : 0, [board, shareId, authorId]);
  const actions = sync.actions;
  const erasable = canModerate && Boolean(actions) && count > 0;
  if (confirming && !erasable) setConfirming(false);

  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(false), CONFIRM_MS);
    return () => window.clearTimeout(timer);
  }, [confirming]);

  if (!count) return null;

  async function erase() {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    setBusy(true);
    try { await actions?.clearAuthor(authorId); } // failures reach the sync notices
    finally { setBusy(false); }
  }

  return <div className="flex shrink-0 items-center gap-1.5">
    <span className="whitespace-nowrap text-xs text-slate-300">{marksCountLabel(count)}</span>
    {erasable && <Button type="button" variant={confirming ? "destructive" : "ghost"} size={confirming ? "xs" : "icon-xs"} title="Стереть пометки участника" aria-label={confirming ? `Стереть ${count}? Нажмите ещё раз для подтверждения` : "Стереть пометки участника"} disabled={busy} className={confirming ? "" : "text-slate-300 hover:bg-white/10 hover:text-white"} onBlur={() => setConfirming(false)} onClick={() => void erase()}><Eraser />{confirming && `Стереть ${count}?`}</Button>}
  </div>;
}

// Authors of marks on the current share who have no row in the list (left or removed): «Вышли», with the same count and erase.
export function DepartedAuthors({ sync, shareId, presentIds, canModerate }: { sync: AnnotationSync; shareId: string; presentIds: ReadonlySet<string>; canModerate: boolean }) {
  const board = useBoard(sync.store);
  const authors = useMemo(() => {
    const names = new Map<string, string>();
    if (board.shareId !== shareId) return names;
    for (const item of board.items) if (!presentIds.has(item.authorId) && !names.get(item.authorId)) names.set(item.authorId, item.authorName);
    return names;
  }, [board, shareId, presentIds]);
  if (!authors.size) return null;
  return <>
    <p className="px-2 pb-2 pt-1 text-xs uppercase tracking-[.12em] text-slate-400">Вышли</p>
    {[...authors].map(([id, name]) => {
      const label = authorLabel(name, id, sync.store.nameOf) || "Участник";
      return <div key={id} className="mb-2 rounded-xl bg-[#20344e] p-3">
        <div className="flex items-center gap-2"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white/10 text-sm font-semibold text-slate-300">{label.charAt(0).toUpperCase()}</span><p className="min-w-0 flex-1 truncate text-sm font-medium text-slate-200">{label}</p><AuthorMarks sync={sync} shareId={shareId} authorId={id} canModerate={canModerate} /></div>
      </div>;
    })}
  </>;
}
