import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clampFloatingPanel } from "./floating-panel.ts";

describe("clampFloatingPanel", () => {
  const container = { width: 800, height: 600 };
  const panel = { width: 240, height: 160 };

  it("keeps a dragged panel inside the scene with a margin", () => {
    assert.deepEqual(clampFloatingPanel({ x: -100, y: -50 }, container, panel), { x: 12, y: 12 });
    assert.deepEqual(clampFloatingPanel({ x: 900, y: 800 }, container, panel), { x: 548, y: 428 });
    assert.deepEqual(clampFloatingPanel({ x: 300, y: 200 }, container, panel), { x: 300, y: 200 });
  });

  it("repositions a panel after the scene shrinks or the panel grows", () => {
    assert.deepEqual(clampFloatingPanel({ x: 548, y: 428 }, { width: 500, height: 350 }, panel), { x: 248, y: 178 });
    assert.deepEqual(clampFloatingPanel({ x: 300, y: 200 }, container, { width: 700, height: 500 }), { x: 88, y: 88 });
  });

  it("uses the available space when the panel nearly fills or exceeds the scene", () => {
    assert.deepEqual(clampFloatingPanel({ x: 100, y: 100 }, { width: 250, height: 170 }, panel), { x: 5, y: 5 });
    assert.deepEqual(clampFloatingPanel({ x: 100, y: 100 }, { width: 200, height: 120 }, panel), { x: 0, y: 0 });
  });
});
