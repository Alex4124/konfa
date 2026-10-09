import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PALM_GUARD_MS, TENTATIVE_MS, TENTATIVE_PX, abortGesture, gestureInput, gestureStep, initialGesture, isTentativeResolved, pointerKind, startsTentative,
  type GestureEffect, type GestureInput, type GestureState, type PointerKind,
} from "./annotation-gesture.ts";

type Step = [GestureInput["type"], number, PointerKind, number?, { button?: number; primary?: boolean }?];

const input = ([type, id, kind, t = 0, over = {}]: Step): GestureInput => ({ type, id, kind, t, button: over.button ?? 0, primary: over.primary ?? true });

function run(steps: Step[], state: GestureState = initialGesture): { state: GestureState; effects: GestureEffect[] } {
  const effects: GestureEffect[] = [];
  for (const step of steps) {
    const next = gestureStep(state, input(step));
    effects.push(next.effect);
    state = next.state;
  }
  return { state, effects };
}

const second = { primary: false };

describe("gestureStep: single pointer", () => {
  it("mouse draw: start, extend, finish; hover moves are ignored", () => {
    const { state, effects } = run([["move", 1, "mouse"], ["down", 1, "mouse"], ["move", 1, "mouse"], ["move", 1, "mouse"], ["up", 1, "mouse"], ["move", 1, "mouse"]]);
    assert.deepEqual(effects, ["ignore", "start", "extend", "extend", "finish", "ignore"]);
    assert.equal(state.active, null);
  });

  it("right and middle mouse buttons, pen barrel and eraser buttons never draw", () => {
    for (const [kind, button] of [["mouse", 2], ["mouse", 1], ["pen", 2], ["pen", 5]] as [PointerKind, number][]) {
      const { state, effects } = run([["down", 1, kind, 0, { button }], ["move", 1, kind], ["up", 1, kind]]);
      assert.deepEqual(effects, ["ignore", "ignore", "ignore"], `${kind} ${button}`);
      assert.equal(state.active, null);
    }
  });

  it("touch draw", () => {
    const { state, effects } = run([["down", 7, "touch", 1000], ["move", 7, "touch", 1010], ["up", 7, "touch", 1100]]);
    assert.deepEqual(effects, ["start", "extend", "finish"]);
    assert.deepEqual(state.blocked, []);
  });

  it("pointercancel cancels the active stroke", () => {
    assert.deepEqual(run([["down", 7, "touch"], ["cancel", 7, "touch"]]).effects, ["start", "cancel"]);
    assert.deepEqual(run([["down", 1, "pen"], ["cancel", 1, "pen"]]).effects, ["start", "cancel"]);
  });

  it("a down from the active pointer again (lost up) restarts", () => {
    const { state, effects } = run([["down", 1, "mouse"], ["down", 1, "mouse"], ["up", 1, "mouse"]]);
    assert.deepEqual(effects, ["start", "cancel-start", "finish"]);
    assert.equal(state.active, null);
    assert.deepEqual(run([["down", 3, "touch"], ["down", 3, "touch"]]).effects, ["start", "cancel-start"]);
  });

  it("ups and moves of unknown pointers are ignored", () => {
    const { state, effects } = run([["up", 9, "touch"], ["cancel", 9, "pen"], ["down", 1, "mouse"], ["up", 2, "mouse"], ["move", 2, "mouse"]]);
    assert.deepEqual(effects, ["ignore", "ignore", "start", "ignore", "ignore"]);
    assert.deepEqual(state.active, { id: 1, kind: "mouse" });
  });

  it("matches the pointer by id and kind", () => {
    assert.deepEqual(run([["down", 1, "pen"], ["move", 1, "mouse"], ["up", 1, "mouse"], ["up", 1, "pen"]]).effects, ["start", "ignore", "ignore", "finish"]);
  });
});

describe("gestureStep: two fingers never draw", () => {
  it("a second finger cancels the stroke and blocks until both fingers lift", () => {
    const { state, effects } = run([
      ["down", 1, "touch", 0], ["move", 1, "touch", 10], ["down", 2, "touch", 30, second],
      ["move", 1, "touch", 40], ["move", 2, "touch", 40], ["up", 1, "touch", 200], ["move", 2, "touch", 210],
      ["down", 3, "touch", 250, second], ["up", 2, "touch", 300], ["up", 3, "touch", 310],
    ]);
    assert.deepEqual(effects, ["start", "extend", "cancel", "ignore", "ignore", "ignore", "ignore", "ignore", "ignore", "ignore"]);
    assert.deepEqual(state, { ...initialGesture, blocked: [] });
    assert.deepEqual(run([["down", 4, "touch", 400]], state).effects, ["start"], "a fresh finger draws again");
  });

  it("keeps the remaining finger blocked when one of the pair lifts", () => {
    const { state } = run([["down", 1, "touch"], ["down", 2, "touch", 0, second], ["up", 1, "touch"]]);
    assert.deepEqual(state.blocked, [2]);
    assert.deepEqual(run([["down", 5, "touch", 0, second], ["move", 2, "touch"], ["move", 5, "touch"]], state).effects, ["ignore", "ignore", "ignore"]);
  });

  it("a second finger cancels even a stroke that already resolved", () => {
    assert.deepEqual(run([["down", 1, "touch", 0], ["move", 1, "touch", 500], ["down", 2, "touch", 600, second]]).effects, ["start", "extend", "cancel"]);
  });

  it("a non-primary finger never starts a stroke (another finger is down elsewhere)", () => {
    const { state, effects } = run([["down", 2, "touch", 0, second], ["move", 2, "touch"], ["up", 2, "touch"]]);
    assert.deepEqual(effects, ["ignore", "ignore", "ignore"]);
    assert.deepEqual(state.blocked, []);
  });

  it("a primary finger resets blocked fingers whose up was lost", () => {
    const { state } = run([["down", 1, "touch"], ["down", 2, "touch", 0, second], ["up", 1, "touch"]]);
    assert.deepEqual(state.blocked, [2]);
    const next = run([["down", 3, "touch", 100]], state);
    assert.deepEqual(next.effects, ["start"]);
    assert.deepEqual(next.state.blocked, []);
  });

  it("three fingers: everything stays blocked", () => {
    const { state, effects } = run([["down", 1, "touch"], ["down", 2, "touch", 0, second], ["down", 3, "touch", 0, second]]);
    assert.deepEqual(effects, ["start", "cancel", "ignore"]);
    assert.deepEqual([...state.blocked].sort(), [1, 2, 3]);
  });

  it("mouse and pen still work while fingers are blocked", () => {
    const { state } = run([["down", 1, "touch"], ["down", 2, "touch", 0, second]]);
    assert.deepEqual(run([["down", 10, "pen", 5], ["up", 10, "pen", 6]], state).effects, ["start", "finish"]);
    assert.deepEqual(run([["down", 11, "mouse", 5]], state).effects, ["start"]);
  });
});

describe("gestureStep: palm rejection", () => {
  it("ignores touches while the pen draws", () => {
    const { effects } = run([["down", 1, "pen", 0], ["down", 2, "touch", 10], ["move", 2, "touch", 20], ["move", 1, "pen", 20], ["up", 2, "touch", 30], ["up", 1, "pen", 40]]);
    assert.deepEqual(effects, ["start", "ignore", "ignore", "extend", "ignore", "finish"]);
  });

  it(`ignores a touch within ${PALM_GUARD_MS} ms after the pen lifts, accepts it after`, () => {
    const { state } = run([["down", 1, "pen", 1000], ["up", 1, "pen", 2000]]);
    assert.equal(state.lastPenAt, 2000);
    assert.deepEqual(run([["down", 2, "touch", 2000 + PALM_GUARD_MS - 1]], state).effects, ["ignore"]);
    assert.deepEqual(run([["down", 2, "touch", 2600]], state).effects, ["start"]);
    assert.deepEqual(run([["down", 2, "touch", 2000 + PALM_GUARD_MS]], state).effects, ["start"]);
  });

  it("pen hover keeps the palm guard alive", () => {
    const { state } = run([["move", 1, "pen", 5000], ["move", 1, "pen", 5300]]);
    assert.equal(state.lastPenAt, 5300);
    assert.deepEqual(run([["down", 2, "touch", 5600]], state).effects, ["ignore"]);
    assert.deepEqual(run([["down", 2, "touch", 5900]], state).effects, ["start"]);
  });

  it("the palm guard never blocks the mouse or the pen", () => {
    const { state } = run([["down", 1, "pen", 0], ["up", 1, "pen", 100]]);
    assert.deepEqual(run([["down", 1, "pen", 150]], state).effects, ["start"]);
    assert.deepEqual(run([["down", 2, "mouse", 150]], state).effects, ["start"]);
  });

  it("touch then pen: the pen takes over, the finger stays blocked until it lifts", () => {
    const { state, effects } = run([["down", 1, "touch", 0], ["down", 2, "pen", 30], ["move", 1, "touch", 40], ["move", 2, "pen", 40], ["up", 1, "touch", 50], ["up", 2, "pen", 60]]);
    assert.deepEqual(effects, ["start", "cancel-start", "ignore", "extend", "ignore", "finish"]);
    assert.deepEqual(state.blocked, []);
    assert.equal(state.active, null);
  });

  it("the mouse never steals an active stroke, and nothing steals the mouse", () => {
    assert.deepEqual(run([["down", 1, "touch"], ["down", 2, "mouse"], ["move", 1, "touch"]]).effects, ["start", "ignore", "extend"]);
    assert.deepEqual(run([["down", 1, "mouse"], ["down", 2, "touch"], ["down", 3, "pen"], ["move", 1, "mouse"]]).effects, ["start", "ignore", "ignore", "extend"]);
    assert.deepEqual(run([["down", 1, "pen"], ["down", 2, "pen"], ["move", 1, "pen"]]).effects, ["start", "ignore", "extend"]);
  });
});

describe("gestureStep: state handling", () => {
  it("never mutates the previous state and returns it when nothing changes", () => {
    const frozen = run([["down", 1, "touch"], ["down", 2, "touch", 0, second]]).state;
    const snapshot = JSON.stringify(frozen);
    run([["up", 1, "touch"], ["up", 2, "touch"], ["down", 3, "touch", 1000]], frozen);
    assert.equal(JSON.stringify(frozen), snapshot);
    assert.equal(gestureStep(initialGesture, input(["move", 1, "mouse"])).state, initialGesture);
    assert.ok(Object.isFrozen(initialGesture));
  });

  it("abortGesture drops the active stroke; a finger stays blocked until it lifts", () => {
    assert.equal(abortGesture(initialGesture), initialGesture);
    const touch = abortGesture(run([["down", 1, "touch"]]).state);
    assert.deepEqual(touch, { ...initialGesture, blocked: [1] });
    assert.deepEqual(run([["move", 1, "touch"], ["down", 2, "touch", 0, second], ["up", 1, "touch"], ["up", 2, "touch"]], touch).effects, ["ignore", "ignore", "ignore", "ignore"]);
    const mouse = abortGesture(run([["down", 1, "mouse"]]).state);
    assert.deepEqual(mouse, initialGesture);
    assert.deepEqual(run([["move", 1, "mouse"], ["up", 1, "mouse"], ["down", 1, "mouse"]], mouse).effects, ["ignore", "ignore", "start"]);
  });
});

describe("pointer helpers", () => {
  it("pointerKind maps unknown types to mouse", () => {
    assert.equal(pointerKind("pen"), "pen");
    assert.equal(pointerKind("touch"), "touch");
    assert.equal(pointerKind("mouse"), "mouse");
    assert.equal(pointerKind(""), "mouse");
  });

  it("gestureInput copies the event fields", () => {
    assert.deepEqual(gestureInput("down", { pointerId: 4, pointerType: "touch", button: 0, isPrimary: false }, 123), { type: "down", id: 4, kind: "touch", button: 0, primary: false, t: 123 });
  });

  it("only touch strokes start tentative", () => {
    assert.equal(startsTentative("touch"), true);
    assert.equal(startsTentative("pen"), false);
    assert.equal(startsTentative("mouse"), false);
  });

  it(`isTentativeResolved after ${TENTATIVE_MS} ms or ${TENTATIVE_PX} px`, () => {
    const start = { t: 1000, x: 100, y: 100 };
    assert.equal(isTentativeResolved(start, { t: 1000, x: 100, y: 100 }), false);
    assert.equal(isTentativeResolved(start, { t: 1000 + TENTATIVE_MS - 1, x: 105, y: 106 }), false, "7.8 px");
    assert.equal(isTentativeResolved(start, { t: 1000 + TENTATIVE_MS, x: 100, y: 100 }), true);
    assert.equal(isTentativeResolved(start, { t: 1010, x: 100 + TENTATIVE_PX, y: 100 }), true);
    assert.equal(isTentativeResolved(start, { t: 1010, x: 94, y: 108 }), true, "10 px diagonal");
  });
});
