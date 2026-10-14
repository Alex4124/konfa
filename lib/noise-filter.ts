// Noise suppression on the microphone: RNNoise runs in the speaker's browser (lib/noise-processor.ts) on top of the
// browser's own echo cancellation and noise suppression. It is on unless the participant turned it off; the choice is
// kept per browser.

export type NoiseFilterChoice = "on" | "off";
// What the microphone track has now: our filter, nothing, or another processor (never replaced).
export type AttachedProcessor = "ours" | "none" | "other";
export type NoiseFilterStep = "apply" | "remove" | "keep";

export const NOISE_FILTER_KEY = "confa:noise-filter:v1";
export const DEFAULT_NOISE_FILTER: NoiseFilterChoice = "on";
export const NOISE_FILTER_NAME = "konfa-rnnoise";

export function parseNoiseFilter(raw: unknown): NoiseFilterChoice {
  return raw === "off" ? "off" : DEFAULT_NOISE_FILTER;
}

// wanted: the participant's choice; available: the browser can run the filter and it has not failed on this page.
export function noiseFilterStep({ wanted, available, attached }: { wanted: boolean; available: boolean; attached: AttachedProcessor }): NoiseFilterStep {
  if (attached === "other") return "keep";
  if (wanted && available) return attached === "ours" ? "keep" : "apply";
  return attached === "ours" ? "remove" : "keep";
}

// The filter is an AudioWorklet with a WebAssembly model: Chrome 66+, Firefox 76+, Safari 14.1+.
export function supportsNoiseFilter(scope: object = globalThis): boolean {
  const { AudioContext: Context, AudioWorkletNode: Worklet, WebAssembly: Wasm } = scope as { AudioContext?: unknown; AudioWorkletNode?: unknown; WebAssembly?: unknown };
  return typeof Context === "function" && typeof Worklet === "function" && typeof Wasm === "object" && Wasm !== null
    && "audioWorklet" in (Context as { prototype: object }).prototype;
}
