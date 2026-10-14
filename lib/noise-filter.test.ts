import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_NOISE_FILTER, noiseFilterStep, parseNoiseFilter, supportsNoiseFilter } from "./noise-filter.ts";

describe("parseNoiseFilter", () => {
  it("is on unless the participant turned it off", () => {
    assert.equal(DEFAULT_NOISE_FILTER, "on");
    assert.equal(parseNoiseFilter("off"), "off");
    assert.equal(parseNoiseFilter("on"), "on");
    for (const raw of [null, undefined, "", "OFF", "false", 0, {}]) assert.equal(parseNoiseFilter(raw), "on");
  });
});

describe("noiseFilterStep", () => {
  it("puts the filter on a bare microphone the participant wants filtered", () => {
    assert.equal(noiseFilterStep({ wanted: true, available: true, attached: "none" }), "apply");
    assert.equal(noiseFilterStep({ wanted: true, available: true, attached: "ours" }), "keep");
  });

  it("takes it off when turned off or no longer available", () => {
    assert.equal(noiseFilterStep({ wanted: false, available: true, attached: "ours" }), "remove");
    assert.equal(noiseFilterStep({ wanted: true, available: false, attached: "ours" }), "remove");
    assert.equal(noiseFilterStep({ wanted: false, available: true, attached: "none" }), "keep");
    assert.equal(noiseFilterStep({ wanted: true, available: false, attached: "none" }), "keep");
  });

  it("never replaces another processor", () => {
    for (const wanted of [true, false]) {
      for (const available of [true, false]) assert.equal(noiseFilterStep({ wanted, available, attached: "other" }), "keep");
    }
  });
});

describe("supportsNoiseFilter", () => {
  // Browsers define audioWorklet as a getter on the context's prototype.
  class WithWorklet { get audioWorklet() { return {}; } }
  class WithoutWorklet {}
  const Worklet = class {};

  it("needs AudioWorklet and WebAssembly", () => {
    assert.equal(supportsNoiseFilter({ AudioContext: WithWorklet, AudioWorkletNode: Worklet, WebAssembly: {} }), true);
    assert.equal(supportsNoiseFilter({ AudioContext: WithoutWorklet, AudioWorkletNode: Worklet, WebAssembly: {} }), false);
    assert.equal(supportsNoiseFilter({ AudioContext: WithWorklet, WebAssembly: {} }), false);
    assert.equal(supportsNoiseFilter({ AudioContext: WithWorklet, AudioWorkletNode: Worklet }), false);
    assert.equal(supportsNoiseFilter({}), false);
  });

  it("is false on the server", () => {
    assert.equal(supportsNoiseFilter(), false);
  });
});
