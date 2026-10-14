import path from "node:path";
import type { Plugin } from "vite";
import { vendorAssets } from "./vendor-assets";

// The microphone's noise filter (lib/noise-processor.ts): the RNNoise worklet and its model, with and without SIMD,
// served under /noise/.
export function noiseAssets(): Plugin {
  const dist = path.resolve("node_modules", "@sapphi-red", "web-noise-suppressor", "dist");
  return vendorAssets({
    name: "konfa-noise-assets",
    prefix: "noise",
    files: () => new Map([
      ["rnnoise-worklet.js", path.join(dist, "rnnoise", "workletProcessor.js")],
      ["rnnoise.wasm", path.join(dist, "rnnoise.wasm")],
      ["rnnoise_simd.wasm", path.join(dist, "rnnoise_simd.wasm")],
    ]),
  });
}
