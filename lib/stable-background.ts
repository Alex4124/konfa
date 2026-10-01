"use client";

import { FilesetResolver, ImageSegmenter } from "@mediapipe/tasks-vision";
import { ProcessorWrapper, supportsBackgroundProcessors } from "@livekit/track-processors";

type Canvas2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type InitOptions = { outputCanvas: OffscreenCanvas | HTMLCanvasElement; inputElement: HTMLVideoElement };
type BackgroundOptions = { imagePath: string };

class StableBackgroundTransformer {
  transformer?: TransformStream<VideoFrame, VideoFrame>;
  private output?: OffscreenCanvas | HTMLCanvasElement;
  private outputContext?: Canvas2D;
  private maskCanvas = document.createElement("canvas");
  private maskContext = this.maskCanvas.getContext("2d");
  private maskPixels?: ImageData;
  private visionCanvas = document.createElement("canvas");
  private segmenter?: ImageSegmenter;
  private personMaskIndex = 0;
  private background?: ImageBitmap;
  private previousMask?: Float32Array;
  private lastTimestamp = 0;
  private failed = false;

  constructor(private options: BackgroundOptions, private onError: (message: string) => void) {}

  async init({ outputCanvas }: InitOptions) {
    if (!this.maskContext) throw new Error("Не удалось обработать фон камеры");
    this.output = outputCanvas;
    this.outputContext = outputCanvas.getContext("2d") as Canvas2D | null ?? undefined;
    if (!this.outputContext) throw new Error("Не удалось обработать фон камеры");
    this.visionCanvas.width = outputCanvas.width;
    this.visionCanvas.height = outputCanvas.height;
    const files = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm");
    this.segmenter = await ImageSegmenter.createFromOptions(files, {
      baseOptions: {
        modelAssetPath: "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite",
        delegate: "GPU",
      },
      canvas: this.visionCanvas,
      runningMode: "VIDEO",
      outputCategoryMask: false,
      outputConfidenceMasks: true,
    });
    const labels = this.segmenter.getLabels();
    const person = labels.findIndex((label) => /person|foreground|человек/i.test(label));
    this.personMaskIndex = person >= 0 ? person : labels.length > 1 ? 1 : 0;
    await this.update(this.options);
    this.transformer = new TransformStream<VideoFrame, VideoFrame>({
      transform: (frame, controller) => this.transform(frame, controller),
    });
  }

  async update(options: BackgroundOptions) {
    const image = new Image();
    image.crossOrigin = "anonymous";
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Не удалось открыть изображение фона"));
      image.src = options.imagePath;
    });
    const next = await createImageBitmap(image);
    this.background?.close();
    this.background = next;
    this.options = options;
    this.previousMask = undefined;
    this.failed = false;
  }

  async restart(options: InitOptions) {
    await this.destroy();
    await this.init(options);
  }

  async destroy() {
    this.segmenter?.close();
    this.segmenter = undefined;
    this.background?.close();
    this.background = undefined;
    this.previousMask = undefined;
    this.maskPixels = undefined;
    this.output = undefined;
    this.outputContext = undefined;
    this.transformer = undefined;
  }

  transform(frame: VideoFrame, controller: TransformStreamDefaultController<VideoFrame>) {
    try {
      if (this.failed || !this.segmenter || !this.output || !this.outputContext || !this.background || !this.maskContext) {
        controller.enqueue(frame.clone());
        return;
      }
      const timestamp = Math.max(performance.now(), this.lastTimestamp + 0.001);
      this.lastTimestamp = timestamp;
      if (this.visionCanvas.width !== frame.displayWidth || this.visionCanvas.height !== frame.displayHeight) {
        this.visionCanvas.width = frame.displayWidth;
        this.visionCanvas.height = frame.displayHeight;
        this.previousMask = undefined;
      }
      const result = this.segmenter.segmentForVideo(frame, timestamp);
      try {
        const masks = result.confidenceMasks;
        const mask = masks?.[Math.min(this.personMaskIndex, masks.length - 1)];
        if (!mask) throw new Error("Не удалось распознать человека");
        const current = mask.getAsFloat32Array();
        if (!this.previousMask || this.previousMask.length !== current.length) this.previousMask = new Float32Array(current);
        if (this.maskCanvas.width !== mask.width || this.maskCanvas.height !== mask.height) {
          this.maskCanvas.width = mask.width;
          this.maskCanvas.height = mask.height;
          this.maskPixels = this.maskContext.createImageData(mask.width, mask.height);
        }
        const pixels = this.maskPixels ??= this.maskContext.createImageData(mask.width, mask.height);
        for (let i = 0; i < current.length; i++) {
          const old = this.previousMask[i];
          const value = Math.max(0, Math.min(1, current[i]));
          const speed = Math.abs(value - old) > 0.2 ? 0.7 : 0.3;
          const stable = old + (value - old) * speed;
          this.previousMask[i] = stable;
          const edge = Math.max(0, Math.min(1, (stable - 0.36) / 0.28));
          const alpha = edge * edge * (3 - 2 * edge);
          const offset = i * 4;
          pixels.data[offset] = 255;
          pixels.data[offset + 1] = 255;
          pixels.data[offset + 2] = 255;
          pixels.data[offset + 3] = Math.round(alpha * 255);
        }
        this.maskContext.putImageData(pixels, 0, 0);
        const width = frame.displayWidth;
        const height = frame.displayHeight;
        if (this.output.width !== width || this.output.height !== height) {
          this.output.width = width;
          this.output.height = height;
          this.previousMask = undefined;
        }
        const context = this.outputContext;
        context.globalCompositeOperation = "source-over";
        context.clearRect(0, 0, width, height);
        context.drawImage(frame, 0, 0, width, height);
        context.globalCompositeOperation = "destination-in";
        context.drawImage(this.maskCanvas, 0, 0, width, height);
        context.globalCompositeOperation = "destination-over";
        const background = this.background;
        const scale = Math.max(width / background.width, height / background.height);
        const sourceWidth = width / scale;
        const sourceHeight = height / scale;
        context.drawImage(background, (background.width - sourceWidth) / 2, (background.height - sourceHeight) / 2, sourceWidth, sourceHeight, 0, 0, width, height);
        context.globalCompositeOperation = "source-over";
        controller.enqueue(new VideoFrame(this.output, { timestamp: frame.timestamp || Math.round(timestamp * 1000) }));
      } finally {
        result.close();
      }
    } catch (error) {
      this.failed = true;
      this.onError(error instanceof Error ? error.message : "Обработка фона недоступна");
      controller.enqueue(frame.clone());
    } finally {
      frame.close();
    }
  }
}

export class StableBackgroundProcessor extends ProcessorWrapper<BackgroundOptions, StableBackgroundTransformer> {
  async switchBackground(imagePath: string) {
    await this.updateTransformerOptions({ imagePath });
  }
}

export function createStableBackgroundProcessor(imagePath: string, onError: (message: string) => void): StableBackgroundProcessor {
  if (!supportsBackgroundProcessors()) throw new Error("Этот браузер не поддерживает замену фона");
  return new StableBackgroundProcessor(new StableBackgroundTransformer({ imagePath }, onError), `confa-background-${crypto.randomUUID()}`, { maxFps: 24 });
}
