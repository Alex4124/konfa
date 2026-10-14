"use client";

import type { AudioProcessorOptions, Track, TrackProcessor } from "livekit-client";
import { NOISE_FILTER_NAME } from "@/lib/noise-filter";

// The microphone through RNNoise: source → RNNoise worklet → a new track that LiveKit sends instead of the raw one.
// The files are served by our own server under /noise/ (build/noise-assets.ts).
const WORKLET_URL = "/noise/rnnoise-worklet.js";
const WASM_URL = "/noise/rnnoise.wasm";
const SIMD_WASM_URL = "/noise/rnnoise_simd.wasm";
// RNNoise works on 48 kHz frames; LiveKit's own context runs at whatever rate the device has, so the filter has its own.
const SAMPLE_RATE = 48000;
const RESUME_WAIT = 1000;
const STALL_WAIT = 3000;

type NoiseLibrary = typeof import("@sapphi-red/web-noise-suppressor");
type RnnoiseNode = InstanceType<NoiseLibrary["RnnoiseWorkletNode"]>;

let wasm: Promise<ArrayBuffer> | null = null;

// One download per page. A failed one (or an error page instead of the model) is fetched again on the next try.
function loadWasm(library: NoiseLibrary): Promise<ArrayBuffer> {
  if (!wasm) {
    const loading = library.loadRnnoise({ url: WASM_URL, simdUrl: SIMD_WASM_URL }).then((binary) => {
      if (!WebAssembly.validate(binary)) throw new Error("Не удалось загрузить шумоподавление");
      return binary;
    });
    wasm = loading;
    loading.catch(() => { if (wasm === loading) wasm = null; });
  }
  return wasm;
}

const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

class RnnoiseFilter implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  readonly name = NOISE_FILTER_NAME;
  processedTrack?: MediaStreamTrack;
  private context?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private node?: RnnoiseNode;
  private destination?: MediaStreamAudioDestinationNode;
  private stallTimer?: number;
  private waitingForPage = false;
  private closed = false;

  constructor(private onStalled: () => void) {}

  async init({ track }: AudioProcessorOptions) {
    try {
      // The package defines a subclass of AudioWorkletNode when it loads: browser only, and only when the filter starts.
      const library = await import("@sapphi-red/web-noise-suppressor");
      const context = this.context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "interactive" });
      const [binary] = await Promise.all([loadWasm(library), context.audioWorklet.addModule(WORKLET_URL)]);
      if (this.closed) throw new Error("Шумоподавление остановлено");
      const node = this.node = new library.RnnoiseWorkletNode(context, { maxChannels: 1, wasmBinary: binary });
      // One channel in and out: a stereo microphone is mixed down instead of losing its second channel.
      node.channelCount = 1;
      node.channelCountMode = "explicit";
      const destination = this.destination = context.createMediaStreamDestination();
      destination.channelCount = 1;
      node.connect(destination);
      this.connect(track);
      // A context that does not run sends silence instead of the voice: then the raw microphone stays on.
      await Promise.race([context.resume(), wait(RESUME_WAIT)]);
      if (context.state !== "running") throw new Error("Звук не запускается");
      context.onstatechange = () => this.watch();
      this.processedTrack = destination.stream.getAudioTracks()[0];
    } catch (cause) {
      await this.destroy();
      throw cause;
    }
  }

  // Another device, or the microphone captured again: only the source changes, LiveKit keeps sending the same track.
  async restart({ track }: AudioProcessorOptions) {
    if (this.closed) throw new Error("Шумоподавление остановлено");
    this.connect(track);
  }

  async destroy() {
    if (this.closed) return;
    this.closed = true;
    window.clearTimeout(this.stallTimer);
    // LiveKit does not stop the processed track when the microphone track itself is stopped.
    this.processedTrack?.stop();
    this.source?.disconnect();
    this.node?.disconnect();
    this.node?.destroy();
    if (!this.context) return;
    this.context.onstatechange = null;
    await this.context.close().catch(() => {});
  }

  private connect(track: MediaStreamTrack) {
    if (!this.context || !this.node) throw new Error("Шумоподавление не запущено");
    this.source?.disconnect();
    this.source = this.context.createMediaStreamSource(new MediaStream([track]));
    this.source.connect(this.node);
  }

  // The browser may suspend or interrupt the context (another app takes the device, a call on a phone). It gets a moment
  // to come back; then the filter is given up and the raw microphone goes out. A hidden page waits until it is shown.
  private watch() {
    const context = this.context;
    if (this.closed || !context) return;
    window.clearTimeout(this.stallTimer);
    if (context.state === "running") return;
    if (context.state !== "closed") void context.resume().catch(() => {});
    this.stallTimer = window.setTimeout(() => {
      if (this.closed || context.state === "running") return;
      if (!document.hidden) { this.onStalled(); return; }
      if (this.waitingForPage) return;
      this.waitingForPage = true;
      document.addEventListener("visibilitychange", () => { this.waitingForPage = false; this.watch(); }, { once: true });
    }, STALL_WAIT);
  }
}

export function createNoiseFilter({ onStalled }: { onStalled: () => void }): TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  return new RnnoiseFilter(onStalled);
}
