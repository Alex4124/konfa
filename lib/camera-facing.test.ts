import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_FACING, countCameras, flipLabel, oppositeFacing, supportsScreenShare } from "./camera-facing.ts";

describe("camera facing", () => {
  it("starts with the front camera and flips both ways", () => {
    assert.equal(DEFAULT_FACING, "user");
    assert.equal(oppositeFacing("user"), "environment");
    assert.equal(oppositeFacing("environment"), "user");
  });

  it("labels the camera the button turns on", () => {
    assert.equal(flipLabel("user"), "Включить заднюю камеру");
    assert.equal(flipLabel("environment"), "Включить переднюю камеру");
  });

  it("counts only cameras", () => {
    assert.equal(countCameras([]), 0);
    assert.equal(countCameras([{ kind: "audioinput" }, { kind: "videoinput" }, { kind: "audiooutput" }]), 1);
    assert.equal(countCameras([{ kind: "videoinput" }, { kind: "videoinput" }, { kind: "videoinput" }]), 3);
  });

  it("tells whether the browser can share a screen", () => {
    assert.equal(supportsScreenShare({ navigator: { mediaDevices: { getDisplayMedia: () => {} } } }), true);
    assert.equal(supportsScreenShare({ navigator: { mediaDevices: {} } }), false);
    assert.equal(supportsScreenShare({ navigator: {} }), false);
    assert.equal(supportsScreenShare({}), false);
  });
});
