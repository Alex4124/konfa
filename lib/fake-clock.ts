import type { TimerHost } from "./annotation-drafts.ts";

// Test helper: a manual clock with the timers the sync code takes (setTimeout/setInterval that fire on advance()).
type Task = { at: number; run: () => void; every: number | null };

export function fakeClock(): { host: TimerHost; now(): number; advance(ms: number): void } {
  let time = 0, nextId = 1;
  const tasks = new Map<number, Task>();
  const add = (handler: TimerHandler, ms: number | undefined, every: boolean) => {
    const id = nextId++;
    tasks.set(id, { at: time + Math.max(0, ms ?? 0), run: () => { if (typeof handler === "function") handler(); }, every: every ? Math.max(1, ms ?? 0) : null });
    return id;
  };
  const host: TimerHost = {
    setTimeout: (handler: TimerHandler, ms?: number) => add(handler, ms, false),
    clearTimeout: (id?: number) => { if (id !== undefined) tasks.delete(id); },
    setInterval: (handler: TimerHandler, ms?: number) => add(handler, ms, true),
    clearInterval: (id?: number) => { if (id !== undefined) tasks.delete(id); },
  };
  return {
    host,
    now: () => time,
    advance(ms: number) {
      const end = time + ms;
      for (;;) {
        let due: [number, Task] | null = null;
        for (const entry of tasks) if (entry[1].at <= end && (!due || entry[1].at < due[1].at)) due = entry;
        if (!due) break;
        const [id, task] = due;
        time = Math.max(time, task.at);
        if (task.every) task.at += task.every;
        else tasks.delete(id);
        task.run();
      }
      time = end;
    },
  };
}
