// Multi-pointer guard for the layer when the frame is not zoomable (PiP, touch laptop): two fingers never draw,
// the palm is ignored while and right after a pen is used. With a zoomable frame SharedScreen's arbiter owns this.
// Feed every pointer event the layer sees (pen hover moves too); `t` is the opener's module-scope performance.now().

export type PointerKind = "mouse" | "pen" | "touch";
export type GestureInput = { type: "down" | "move" | "up" | "cancel"; id: number; kind: PointerKind; button: number; primary: boolean; t: number };
export type GestureState = Readonly<{ active: Readonly<{ id: number; kind: PointerKind }> | null; blocked: readonly number[]; lastPenAt: number }>;
// start: begin a stroke for this pointer; extend/finish: the active stroke; cancel: drop it; cancel-start: drop it and start one for this pointer.
export type GestureEffect = "start" | "extend" | "finish" | "cancel" | "cancel-start" | "ignore";
export type GestureResult = { state: GestureState; effect: GestureEffect };
export type PointerEventLike = { pointerId: number; pointerType: string; button: number; isPrimary: boolean };
export type TentativeSample = { t: number; x: number; y: number };

export const PALM_GUARD_MS = 500;
// A touch stroke stays tentative (not rendered, not sent) until it lasts TENTATIVE_MS or moves TENTATIVE_PX screen px.
export const TENTATIVE_MS = 80;
export const TENTATIVE_PX = 8;

export const initialGesture: GestureState = Object.freeze({ active: null, blocked: Object.freeze([]), lastPenAt: -Infinity });

export function pointerKind(pointerType: string): PointerKind {
  return pointerType === "pen" || pointerType === "touch" ? pointerType : "mouse";
}

export function gestureInput(type: GestureInput["type"], event: PointerEventLike, t: number): GestureInput {
  return { type, id: event.pointerId, kind: pointerKind(event.pointerType), button: event.button, primary: event.isPrimary, t };
}

const withId = (ids: readonly number[], ...add: number[]) => [...ids, ...add.filter((id, i) => !ids.includes(id) && add.indexOf(id) === i)];
const result = (state: GestureState, effect: GestureEffect): GestureResult => ({ state, effect });

export function gestureStep(prev: GestureState, input: GestureInput): GestureResult {
  const s: GestureState = input.kind === "pen" && input.t > prev.lastPenAt ? { ...prev, lastPenAt: input.t } : prev;
  const active = s.active;
  const own = active !== null && active.id === input.id && active.kind === input.kind;

  if (input.type === "move") return result(s, own ? "extend" : "ignore");

  if (input.type === "up" || input.type === "cancel") {
    if (own) return result({ ...s, active: null }, input.type === "up" ? "finish" : "cancel");
    if (input.kind === "touch" && s.blocked.includes(input.id)) return result({ ...s, blocked: s.blocked.filter((id) => id !== input.id) }, "ignore");
    return result(s, "ignore");
  }

  // down: right/middle mouse, pen barrel and eraser buttons never draw
  if (input.button !== 0) return result(s, "ignore");
  const self = { id: input.id, kind: input.kind };
  if (own) return result({ ...s, active: self }, "cancel-start"); // lost up (e.g. alt-tab)

  if (input.kind === "touch") {
    // A primary touch means no other finger is down: forget fingers whose up was lost.
    const base: GestureState = input.primary && s.blocked.length ? { ...s, blocked: [] } : s;
    if (active?.kind === "touch") return result({ ...base, active: null, blocked: withId(base.blocked, active.id, input.id) }, "cancel");
    if (active) return result(base, "ignore"); // palm under a pen, or a finger next to the mouse
    if (!input.primary || base.blocked.length) return result({ ...base, blocked: withId(base.blocked, input.id) }, "ignore");
    if (input.t - base.lastPenAt < PALM_GUARD_MS) return result(base, "ignore");
    return result({ ...base, active: self }, "start");
  }

  if (!active) return result({ ...s, active: self }, "start");
  // The pen wins over a finger that landed first (usually the palm); the cancelled finger stays blocked until it lifts.
  if (input.kind === "pen" && active.kind === "touch") return result({ ...s, active: self, blocked: withId(s.blocked, active.id) }, "cancel-start");
  return result(s, "ignore");
}

// The layer cancelled the stroke on its own (visibility, revoke, arbiter): forget it; an active finger stays blocked until it lifts.
export function abortGesture(s: GestureState): GestureState {
  if (!s.active) return s;
  return { ...s, active: null, blocked: s.active.kind === "touch" ? withId(s.blocked, s.active.id) : s.blocked };
}

export function startsTentative(kind: PointerKind): boolean {
  return kind === "touch";
}

// `x`/`y` are screen (client) px, `t` the same clock as gesture inputs.
export function isTentativeResolved(start: TentativeSample, now: TentativeSample): boolean {
  return now.t - start.t >= TENTATIVE_MS || Math.hypot(now.x - start.x, now.y - start.y) >= TENTATIVE_PX;
}
