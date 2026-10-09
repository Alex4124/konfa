// Browser only: the teacher's upload handler loads this module with import(), so pdf.js never runs during SSR.
// Every material becomes page images: PowerPoint and Word go through the server's converter to PDF, PDF pages are rendered
// by pdf.js, a picture is one page. The server stores the images; everyone else only ever loads <img> pages.
import type { DocumentKind } from "@/lib/confa-types";
import { classifyUpload, extensionOf, fitLongSide, MAX_CONVERT_BYTES, MAX_DOC_PAGES, MAX_PAGE_BYTES, MAX_SOURCE_BYTES, PAGE_LONG_SIDE } from "@/lib/workspace";

export type UploadStage = "convert" | "read" | "upload" | "finish";
export type UploadProgress = { stage: UploadStage; done: number; total: number };
export type UploadOptions = {
  file: File;
  roomId: string;
  token: string;
  signal: AbortSignal;
  onProgress(progress: UploadProgress): void;
  confirmPages(total: number, max: number): boolean; // more pages than a material may have: upload the first `max`?
};
type PageSource = { sizes: Array<[number, number]>; render(index: number, canvas: HTMLCanvasElement): Promise<void>; close(): void };

export class UploadError extends Error {}

const PDFJS_BASE = "/pdfjs/";
const IMAGE_LONG_SIDE = 2400; // photos keep a little more detail than rendered pages
const MAX_RENDER_SCALE = 4; // a tiny PDF page is not blown up past this
const RETRY_DELAYS_MS = [500, 1500];
const IN_FLIGHT = 2;

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { window.clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}

// Lets the page (camera, background blur, the call itself) breathe between two rendered pages.
const breathe = () => new Promise<void>((resolve) => window.setTimeout(resolve, 0));

async function failureOf(response: Response, fallback: string): Promise<UploadError> {
  try {
    const body = await response.json() as { error?: unknown };
    if (typeof body.error === "string" && body.error) return new UploadError(body.error);
  } catch { /* Not JSON */ }
  return new UploadError(fallback);
}

async function post<T>(o: UploadOptions, path: string, body: Record<string, unknown>, signal: AbortSignal | undefined = o.signal): Promise<T> {
  const response = await fetch(`/api/rooms/${o.roomId}/${path}`, { method: "POST", headers: { Authorization: `Bearer ${o.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  if (!response.ok) throw await failureOf(response, "Не удалось загрузить материал");
  return await response.json() as T;
}

async function convert(o: UploadOptions, ext: string): Promise<Blob> {
  if (o.file.size > MAX_CONVERT_BYTES) throw new UploadError("Файл больше 50 МБ — сохраните его как PDF и загрузите снова");
  o.onProgress({ stage: "convert", done: 0, total: 0 });
  const response = await fetch(`/api/rooms/${o.roomId}/convert?ext=${encodeURIComponent(ext)}`, { method: "POST", headers: { Authorization: `Bearer ${o.token}`, "Content-Type": "application/octet-stream" }, body: o.file, signal: o.signal });
  if (!response.ok) throw await failureOf(response, "Не удалось преобразовать файл — сохраните его как PDF");
  return await response.blob();
}

async function pdfSource(data: Blob, o: UploadOptions): Promise<PageSource> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}pdf.worker.min.mjs`;
  const task = pdfjs.getDocument({
    data: new Uint8Array(await data.arrayBuffer()),
    wasmUrl: `${PDFJS_BASE}wasm/`,
    standardFontDataUrl: `${PDFJS_BASE}standard_fonts/`,
    cMapUrl: `${PDFJS_BASE}cmaps/`,
    cMapPacked: true,
  });
  const abort = () => void task.destroy();
  o.signal.addEventListener("abort", abort, { once: true });
  let pdf: Awaited<typeof task.promise>;
  try {
    pdf = await task.promise;
  } catch (error) {
    o.signal.removeEventListener("abort", abort);
    if (o.signal.aborted) throw o.signal.reason;
    if (error instanceof Error && error.name === "PasswordException") throw new UploadError("Файл защищён паролем — снимите защиту и загрузите снова");
    throw new UploadError("Не удалось открыть PDF — файл повреждён или не поддерживается");
  }
  const close = () => {
    o.signal.removeEventListener("abort", abort);
    void task.destroy();
  };
  try {
    let count = pdf.numPages;
    if (count > MAX_DOC_PAGES) {
      if (!o.confirmPages(count, MAX_DOC_PAGES)) throw new DOMException("Загрузка отменена", "AbortError");
      count = MAX_DOC_PAGES;
    }
    // Rendered so the long side is PAGE_LONG_SIDE px (PDF units are points: slides come out about 2x).
    const scales: number[] = [];
    const sizes: Array<[number, number]> = [];
    for (let index = 0; index < count; index++) {
      const page = await pdf.getPage(index + 1);
      const { width, height } = page.getViewport({ scale: 1 });
      const scale = Math.min(MAX_RENDER_SCALE, PAGE_LONG_SIDE / Math.max(width, height));
      scales.push(scale);
      sizes.push([Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))]);
      page.cleanup();
    }
    return {
      sizes,
      async render(index, canvas) {
        const page = await pdf.getPage(index + 1);
        try {
          [canvas.width, canvas.height] = sizes[index];
          await page.render({ canvas, viewport: page.getViewport({ scale: scales[index] }), background: "#ffffff" }).promise;
        } finally { page.cleanup(); }
      },
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}

async function imageSource(file: File): Promise<PageSource> {
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch { throw new UploadError("Не удалось открыть картинку — файл повреждён или не поддерживается"); }
  const { width, height } = fitLongSide(bitmap.width, bitmap.height, IMAGE_LONG_SIDE);
  return {
    sizes: [[width, height]],
    async render(_index, canvas) {
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new UploadError("Браузер не может подготовить картинку");
      context.fillStyle = "#ffffff"; // a transparent PNG would turn black as JPEG
      context.fillRect(0, 0, width, height);
      context.drawImage(bitmap, 0, 0, width, height);
    },
    close: () => bitmap.close(),
  };
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

// WebP where the browser can encode it (Safari answers with PNG instead: then JPEG), smaller JPEG while a page is too big.
async function encode(canvas: HTMLCanvasElement): Promise<Blob> {
  const webp = await canvasBlob(canvas, "image/webp", 0.85);
  if (webp && webp.type === "image/webp" && webp.size <= MAX_PAGE_BYTES) return webp;
  for (const quality of [0.88, 0.75, 0.6]) {
    const jpeg = await canvasBlob(canvas, "image/jpeg", quality);
    if (jpeg && jpeg.size <= MAX_PAGE_BYTES) return jpeg;
  }
  throw new UploadError("Страница получилась слишком большой");
}

async function sendPage(o: UploadOptions, docId: string, index: number, blob: Blob): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    let response: Response | null = null;
    try {
      response = await fetch(`/api/rooms/${o.roomId}/documents/${docId}/pages/${index}`, { method: "POST", headers: { Authorization: `Bearer ${o.token}`, "Content-Type": blob.type }, body: blob, signal: o.signal });
    } catch (error) {
      if (o.signal.aborted) throw error;
    }
    if (response?.ok) return;
    const retriable = !response || response.status >= 500;
    if (!retriable || attempt >= RETRY_DELAYS_MS.length) throw response ? await failureOf(response, "Не удалось загрузить страницу") : new UploadError("Не удалось загрузить страницу — проверьте соединение");
    await delay(RETRY_DELAYS_MS[attempt], o.signal);
  }
}

// Resolves with the new material's id once all its pages are stored; an abort or failure removes what was uploaded.
export async function uploadDocument(o: UploadOptions): Promise<string> {
  const kind = classifyUpload(o.file.name, o.file.type) as DocumentKind | null;
  if (!kind) throw new UploadError("Этот формат не поддерживается. Загрузите PDF, PowerPoint, Word или картинку");
  if (o.file.size > MAX_SOURCE_BYTES) throw new UploadError("Файл слишком большой");
  const ext = extensionOf(o.file.name);
  const pdf = kind === "office" ? await convert(o, ext) : kind === "pdf" ? o.file : null;
  o.onProgress({ stage: "read", done: 0, total: 0 });
  const source = pdf ? await pdfSource(pdf, o) : await imageSource(o.file);
  let docId: string | null = null;
  try {
    const total = source.sizes.length;
    o.onProgress({ stage: "upload", done: 0, total });
    docId = (await post<{ id: string }>(o, "documents", { action: "create", name: o.file.name, kind, pages: source.sizes })).id;
    const canvas = document.createElement("canvas");
    const inflight: Array<Promise<void>> = [];
    let done = 0;
    for (let index = 0; index < total; index++) {
      o.signal.throwIfAborted();
      await source.render(index, canvas);
      const upload = sendPage(o, docId, index, await encode(canvas)).then(() => {
        done++;
        o.onProgress({ stage: "upload", done, total });
      });
      upload.catch(() => {}); // awaited below; never an unhandled rejection meanwhile
      inflight.push(upload);
      if (inflight.length >= IN_FLIGHT) await inflight.shift();
      await breathe();
    }
    await Promise.all(inflight);
    o.onProgress({ stage: "finish", done: total, total });
    await post(o, `documents/${docId}`, { action: "ready" });
    return docId;
  } catch (error) {
    // Without the aborted signal: the cancel must reach the server even when the teacher pressed «Отменить».
    if (docId) void post(o, `documents/${docId}`, { action: "cancel" }, undefined).catch(() => {});
    throw error;
  } finally {
    source.close();
  }
}
