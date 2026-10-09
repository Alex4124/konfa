// Sizes and surface detection for the presenter's Document Picture-in-Picture window. Pure: no DOM globals.

export type DisplaySurface = "monitor" | "window" | "browser" | "unknown";
export type PipSize = { width: number; height: number };
// Structural subset of MediaStreamTrack, so a LiveKit mediaStreamTrack and test fakes both fit.
export type SettingsTrack = { getSettings(): { displaySurface?: string; width?: number; height?: number; aspectRatio?: number } };

export const PIP_SIZE_KEY = "confa:pip-size:v1";
export const DEFAULT_ASPECT = 16 / 9;
export const PIP_MIN_SIZE: Readonly<PipSize> = Object.freeze({ width: 320, height: 200 });
export const PIP_MAX_SIZE: Readonly<PipSize> = Object.freeze({ width: 1200, height: 900 }); // when the screen size is unknown
export const PIP_SCREEN_SHARE = 0.6;
export const PIP_VIDEO_WIDTH = 480;
export const PIP_VIDEO_MAX_HEIGHT = 360;
export const PIP_TOOLBAR_HEIGHT = 48;
export const PIP_BANNER_HEIGHT = 56; // two lines of text-xs plus padding at 480 px
const SANE_LIMIT = 16384;

function settingsOf(track: SettingsTrack | null | undefined): ReturnType<SettingsTrack["getSettings"]> | null {
  try {
    return track?.getSettings() ?? null;
  } catch {
    return null;
  }
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// Firefox and Safari may omit displaySurface; anything unrecognised is "unknown" (treated like a window share).
export function readDisplaySurface(track: SettingsTrack | null | undefined): DisplaySurface {
  const surface = settingsOf(track)?.displaySurface;
  return surface === "monitor" || surface === "window" || surface === "browser" ? surface : "unknown";
}

// Width / height of the captured frame; the local track reports it reliably right after capture starts.
export function readAspectRatio(track: SettingsTrack | null | undefined, fallback = DEFAULT_ASPECT): number {
  const settings = settingsOf(track);
  if (positive(settings?.width) && positive(settings?.height)) return settings.width / settings.height;
  return positive(settings?.aspectRatio) ? settings.aspectRatio : fallback;
}

// A finite, positive, rounded size no smaller than PIP_MIN_SIZE; null for anything else.
export function normalizePipSize(value: unknown): PipSize | null {
  if (!value || typeof value !== "object") return null;
  const { width, height } = value as Record<string, unknown>;
  if (!positive(width) || !positive(height) || width > SANE_LIMIT || height > SANE_LIMIT) return null;
  return { width: Math.max(PIP_MIN_SIZE.width, Math.round(width)), height: Math.max(PIP_MIN_SIZE.height, Math.round(height)) };
}

export function parsePipSize(raw: string | null | undefined): PipSize | null {
  if (!raw) return null;
  try {
    return normalizePipSize(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function serializePipSize(size: PipSize): string {
  return JSON.stringify({ width: Math.round(size.width), height: Math.round(size.height) });
}

// At most ~60% of the available screen, never below the minimum.
export function pipMaxSize(screen?: PipSize | null): PipSize {
  if (!screen || !positive(screen.width) || !positive(screen.height)) return { ...PIP_MAX_SIZE };
  return {
    width: Math.max(PIP_MIN_SIZE.width, Math.floor(screen.width * PIP_SCREEN_SHARE)),
    height: Math.max(PIP_MIN_SIZE.height, Math.floor(screen.height * PIP_SCREEN_SHARE)),
  };
}

export function clampPipSize(size: PipSize, screen?: PipSize | null): PipSize {
  const max = pipMaxSize(screen);
  const width = positive(size.width) ? size.width : PIP_VIDEO_WIDTH;
  const height = positive(size.height) ? size.height : PIP_MIN_SIZE.height;
  return { width: Math.round(clamp(width, PIP_MIN_SIZE.width, max.width)), height: Math.round(clamp(height, PIP_MIN_SIZE.height, max.height)) };
}

// First-open size: the video at 480 px wide (at most 360 px tall for portrait shares), plus the toolbar and the monitor banner.
export function pipFallbackSize(ratio: number, banner: boolean): PipSize {
  const aspect = positive(ratio) ? clamp(ratio, 0.25, 4) : DEFAULT_ASPECT;
  let videoWidth = PIP_VIDEO_WIDTH;
  let videoHeight = videoWidth / aspect;
  if (videoHeight > PIP_VIDEO_MAX_HEIGHT) {
    videoHeight = PIP_VIDEO_MAX_HEIGHT;
    videoWidth = videoHeight * aspect;
  }
  return {
    width: Math.max(PIP_MIN_SIZE.width, Math.round(videoWidth)),
    height: Math.max(PIP_MIN_SIZE.height, Math.round(videoHeight) + PIP_TOOLBAR_HEIGHT + (banner ? PIP_BANNER_HEIGHT : 0)),
  };
}

// The size the presenter left the window at wins over the computed fallback; both fit the screen.
export function pipInitialSize(fallback: PipSize, saved: PipSize | null | undefined, screen?: PipSize | null): PipSize {
  return clampPipSize(normalizePipSize(saved) ?? fallback, screen);
}
