// Browser failures reported by the inline script (lib/legacy-browser.ts) and app/global-error.tsx. They only go to the
// server log, so `journalctl -u konfa | grep client-error` shows which browser could not run the page. No IP is logged.
export const runtime = "edge";

const MAX_BODY = 2048;
const WINDOW_MS = 10 * 60_000;
const PER_WINDOW = 20;
const seen = new Map<string, { start: number; count: number }>();

function allowed(key: string, now: number): boolean {
  if (seen.size > 5000) for (const [k, v] of seen) if (now - v.start > WINDOW_MS) seen.delete(k);
  const entry = seen.get(key);
  if (!entry || now - entry.start > WINDOW_MS) { seen.set(key, { start: now, count: 1 }); return true; }
  entry.count += 1;
  return entry.count <= PER_WINDOW;
}

// Reads at most MAX_BODY bytes and drains the rest: an unread body stalls the next request on a kept-alive connection.
async function readCapped(request: Request): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (text.length < MAX_BODY) text += decoder.decode(value, { stream: true });
    }
  } catch { /* The client went away */ }
  return text.slice(0, MAX_BODY);
}

function field(data: Record<string, unknown>, key: string, max: number): string {
  const value = data[key];
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, max) : "";
}

export async function POST(request: Request): Promise<Response> {
  const text = await readCapped(request);
  if (!allowed(request.headers.get("CF-Connecting-IP") || "unknown", Date.now())) return new Response(null, { status: 204 });
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") data = parsed as Record<string, unknown>;
  } catch { data = { message: text }; }
  console.warn(`[client-error] ${field(data, "kind", 20) || "unknown"} ${field(data, "path", 120)} ${JSON.stringify(field(data, "message", 300))} at ${field(data, "source", 200)} | ${field(data, "ua", 300)}`);
  return new Response(null, { status: 204 });
}
