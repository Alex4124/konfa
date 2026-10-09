"use client";

import { useEffect } from "react";
import { alertTitle, isAlertActivity } from "@/lib/presenter-alerts";
import type { AnnotationStore } from "@/lib/annotation-sync";

type Options = {
  store: AnnotationStore;
  selfId: string;
  enabled: boolean; // this member owns the active share
  suppressed: boolean; // the PiP window already shows the marks
};

// Fallback where the presenter cannot see the marks: «(n) Новые пометки — Конфа» in the tab title while the tab is hidden or unfocused.
// Plain closure state, no setState: the title is the only output. Reset once the tab is looked at again, and on any option change.
export function usePresenterAlerts({ store, selfId, enabled, suppressed }: Options): void {
  useEffect(() => {
    if (!enabled || suppressed || typeof document === "undefined") return;
    const doc = document;
    const win = doc.defaultView;
    let count = 0, base = "", shown = "";
    const attentive = () => doc.visibilityState === "visible" && doc.hasFocus();
    const reset = () => {
      if (!count) return;
      count = 0;
      if (doc.title === shown) doc.title = base; // never undo a title someone else set meanwhile
    };
    const unsubscribe = store.subscribeActivity((activity) => {
      if (!isAlertActivity(activity, selfId) || attentive()) return;
      if (!count) base = doc.title;
      count++;
      shown = alertTitle(count, base);
      doc.title = shown;
    });
    const onVisibility = () => { if (doc.visibilityState === "visible") reset(); };
    doc.addEventListener("visibilitychange", onVisibility);
    win?.addEventListener("focus", reset);
    return () => {
      unsubscribe();
      doc.removeEventListener("visibilitychange", onVisibility);
      win?.removeEventListener("focus", reset);
      reset();
    };
  }, [store, selfId, enabled, suppressed]);
}
