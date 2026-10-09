import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ASPECT, PIP_BANNER_HEIGHT, PIP_MAX_SIZE, PIP_MIN_SIZE, PIP_SIZE_KEY, PIP_TOOLBAR_HEIGHT, clampPipSize, normalizePipSize, parsePipSize, pipFallbackSize,
  pipInitialSize, pipMaxSize, readAspectRatio, readDisplaySurface, serializePipSize, type SettingsTrack,
} from "./presenter-pip.ts";

const track = (settings: ReturnType<SettingsTrack["getSettings"]>): SettingsTrack => ({ getSettings: () => settings });
const FULL_HD = { width: 1920, height: 1080 };

describe("readDisplaySurface", () => {
  it("passes the three known surfaces through", () => {
    assert.equal(readDisplaySurface(track({ displaySurface: "monitor" })), "monitor");
    assert.equal(readDisplaySurface(track({ displaySurface: "window" })), "window");
    assert.equal(readDisplaySurface(track({ displaySurface: "browser" })), "browser");
  });

  it("reports unknown for other values, missing settings, a missing track and a throwing track", () => {
    assert.equal(readDisplaySurface(track({ displaySurface: "application" })), "unknown");
    assert.equal(readDisplaySurface(track({})), "unknown");
    assert.equal(readDisplaySurface(null), "unknown");
    assert.equal(readDisplaySurface(undefined), "unknown");
    assert.equal(readDisplaySurface({ getSettings: () => { throw new Error("stopped"); } }), "unknown");
  });
});

describe("readAspectRatio", () => {
  it("prefers the frame size, then aspectRatio, then the fallback", () => {
    assert.equal(readAspectRatio(track({ width: 1280, height: 1024 })), 1.25);
    assert.equal(readAspectRatio(track({ aspectRatio: 1.5 })), 1.5);
    assert.equal(readAspectRatio(track({ width: 0, height: 720, aspectRatio: 2 })), 2);
    assert.equal(readAspectRatio(track({})), DEFAULT_ASPECT);
    assert.equal(readAspectRatio(null, 4 / 3), 4 / 3);
    assert.equal(readAspectRatio({ getSettings: () => { throw new Error("x"); } }), DEFAULT_ASPECT);
  });
});

describe("parsePipSize", () => {
  it("uses the versioned storage key", () => {
    assert.equal(PIP_SIZE_KEY, "confa:pip-size:v1");
  });

  it("round-trips a saved size and rounds it", () => {
    assert.deepEqual(parsePipSize(serializePipSize({ width: 640, height: 400 })), { width: 640, height: 400 });
    assert.deepEqual(parsePipSize("{\"width\":640.4,\"height\":399.6}"), { width: 640, height: 400 });
  });

  it("rejects garbage, NaN, strings, zero, negative and absurd values", () => {
    for (const raw of [null, undefined, "", "garbage", "null", "[]", "42", "{\"width\":\"640\",\"height\":400}", "{\"width\":640}", "{\"width\":0,\"height\":400}",
      "{\"width\":-640,\"height\":400}", "{\"width\":1e9,\"height\":400}", "{\"width\":NaN,\"height\":400}"]) assert.equal(parsePipSize(raw), null, String(raw));
    assert.equal(normalizePipSize({ width: Number.NaN, height: 400 }), null);
    assert.equal(normalizePipSize({ width: Number.POSITIVE_INFINITY, height: 400 }), null);
  });

  it("raises a tiny saved size to the minimum", () => {
    assert.deepEqual(parsePipSize("{\"width\":100,\"height\":50}"), { width: PIP_MIN_SIZE.width, height: PIP_MIN_SIZE.height });
  });
});

describe("clamping", () => {
  it("caps at 60% of the screen, or at the fixed maximum when the screen is unknown", () => {
    assert.deepEqual(pipMaxSize(FULL_HD), { width: 1152, height: 648 });
    assert.deepEqual(pipMaxSize(null), PIP_MAX_SIZE);
    assert.deepEqual(pipMaxSize({ width: 0, height: 1080 }), PIP_MAX_SIZE);
    assert.deepEqual(pipMaxSize({ width: 400, height: 300 }), PIP_MIN_SIZE);
  });

  it("keeps sizes between the minimum and the maximum", () => {
    assert.deepEqual(clampPipSize({ width: 5000, height: 5000 }, FULL_HD), { width: 1152, height: 648 });
    assert.deepEqual(clampPipSize({ width: 10, height: 10 }, FULL_HD), PIP_MIN_SIZE);
    assert.deepEqual(clampPipSize({ width: 5000, height: 5000 }), PIP_MAX_SIZE);
    assert.deepEqual(clampPipSize({ width: Number.NaN, height: -1 }, FULL_HD), { width: 480, height: PIP_MIN_SIZE.height });
  });
});

describe("pipFallbackSize", () => {
  it("is 480 wide with the toolbar under a 16:9 video", () => {
    assert.deepEqual(pipFallbackSize(16 / 9, false), { width: 480, height: 270 + PIP_TOOLBAR_HEIGHT });
    assert.equal(PIP_TOOLBAR_HEIGHT, 48);
  });

  it("adds the monitor banner", () => {
    assert.deepEqual(pipFallbackSize(16 / 9, true), { width: 480, height: 318 + PIP_BANNER_HEIGHT });
  });

  it("limits portrait shares to 360 px of video, never narrower than the minimum", () => {
    assert.deepEqual(pipFallbackSize(4 / 3, false), { width: 480, height: 408 });
    assert.deepEqual(pipFallbackSize(9 / 16, false), { width: PIP_MIN_SIZE.width, height: 408 });
    assert.deepEqual(pipFallbackSize(1, false), { width: 360, height: 408 });
  });

  it("keeps very wide shares at least the minimum height and treats bad ratios as 16:9", () => {
    assert.deepEqual(pipFallbackSize(32 / 9, false), { width: 480, height: PIP_MIN_SIZE.height }); // 135 + 48 < 200
    for (const ratio of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) assert.deepEqual(pipFallbackSize(ratio, false), { width: 480, height: 318 }, String(ratio));
  });
});

describe("pipInitialSize", () => {
  const fallback = pipFallbackSize(16 / 9, false);

  it("uses the saved size when there is one, else the fallback", () => {
    assert.deepEqual(pipInitialSize(fallback, { width: 700, height: 420 }, FULL_HD), { width: 700, height: 420 });
    assert.deepEqual(pipInitialSize(fallback, null, FULL_HD), fallback);
    assert.deepEqual(pipInitialSize(fallback, undefined), fallback);
  });

  it("ignores an invalid saved size and fits both into the screen", () => {
    assert.deepEqual(pipInitialSize(fallback, { width: Number.NaN, height: 420 }, FULL_HD), fallback);
    assert.deepEqual(pipInitialSize(fallback, { width: 1600, height: 900 }, FULL_HD), { width: 1152, height: 648 });
    assert.deepEqual(pipInitialSize({ width: 480, height: 408 }, null, { width: 1366, height: 600 }), { width: 480, height: 360 });
  });
});
