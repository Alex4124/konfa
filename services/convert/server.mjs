// PowerPoint and Word to PDF for Конфа's materials (POST /api/rooms/:id/convert streams the teacher's file here).
// Plain Node, no dependencies; listens on 127.0.0.1 only and runs one LibreOffice conversion at a time.
// Deployed with deploy/konfa-convert.service, which also sandboxes LibreOffice (no network but localhost, no app files).
import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 8790);
const SECRET = process.env.CONVERT_SECRET || "";
const SOFFICE = process.env.SOFFICE || "soffice";
const TIMEOUT_MS = Number(process.env.CONVERT_TIMEOUT_MS || 120_000);
const WORK = process.env.CONVERT_WORKDIR || path.join(tmpdir(), "konfa-convert");
const PROFILE = path.join(WORK, "profile");
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_WAITING = 1; // one job may wait behind the running one; more get 503
const EXTENSIONS = new Set(["pptx", "ppt", "odp", "docx", "doc", "odt", "rtf"]);

// The profile LibreOffice runs with: no macros, links are never updated on load, untrusted linked images are blocked.
const SETTINGS = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>0</value></prop></item>
<item oor:path="/org.openoffice.Office.Calc/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>0</value></prop></item>
</oor:items>
`;

if (SECRET.length < 16) {
  console.error("CONVERT_SECRET (at least 16 characters) is required");
  process.exit(1);
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const digest = (value) => createHash("sha256").update(String(value)).digest();
const SECRET_DIGEST = digest(SECRET);
const authorized = (header) => typeof header === "string" && timingSafeEqual(digest(header), SECRET_DIGEST);

const startsWith = (bytes, prefix) => bytes.length >= prefix.length && prefix.every((byte, index) => bytes[index] === byte);

// OOXML and ODF are zip files, .doc/.ppt OLE compound files, .rtf starts with {\rtf (same rule as lib/workspace.ts sniffOffice).
function looksLike(bytes, ext) {
  if (ext === "rtf") return startsWith(bytes, [0x7b, 0x5c, 0x72, 0x74, 0x66]);
  if (ext === "doc" || ext === "ppt") return startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  return startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]);
}

async function resetProfile() {
  await rm(PROFILE, { recursive: true, force: true });
  await mkdir(path.join(PROFILE, "user"), { recursive: true });
  await writeFile(path.join(PROFILE, "user", "registrymodifications.xcu"), SETTINGS);
}

// One conversion at a time; the next waits, the rest are turned away.
let busy = false;
const waiting = [];
const hasRoom = () => !busy || waiting.length < MAX_WAITING;

async function exclusive(task) {
  if (busy) {
    if (waiting.length >= MAX_WAITING) throw new HttpError(503, "busy");
    await new Promise((resolve) => waiting.push(resolve));
  } else busy = true;
  try {
    return await task();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else busy = false;
  }
}

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(SOFFICE, args, { detached: true, stdio: "ignore", env: { ...process.env, HOME: WORK } });
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      resolve("timeout");
    }, TIMEOUT_MS);
    child.on("exit", (code) => { clearTimeout(timer); resolve(code === 0 ? "ok" : "failed"); });
    child.on("error", (error) => { clearTimeout(timer); console.error("soffice did not start", error.message); resolve("failed"); });
  });
}

async function convert(input, ext) {
  const job = await mkdtemp(path.join(WORK, "job-"));
  try {
    // Never the uploaded name: LibreOffice sees input.<allowed extension>.
    const file = path.join(job, `input.${ext}`);
    const out = path.join(job, "out");
    await writeFile(file, input);
    await mkdir(out);
    const started = Date.now();
    const status = await run(["--headless", "--invisible", "--norestore", "--nologo", "--nodefault", "--nolockcheck", `-env:UserInstallation=${pathToFileURL(PROFILE).href}`, "--convert-to", "pdf", "--outdir", out, file]);
    const pdf = await readFile(path.join(out, "input.pdf")).catch(() => null);
    console.log(`convert ${ext} ${input.length} B: ${status} in ${Date.now() - started} ms`);
    if (status !== "ok") await resetProfile(); // a killed or crashed run may leave the profile locked or broken
    if (status === "timeout") throw new HttpError(422, "timeout");
    // soffice can exit 0 without writing anything.
    if (!pdf || !startsWith(pdf, [0x25, 0x50, 0x44, 0x46, 0x2d])) throw new HttpError(422, "not converted");
    return pdf;
  } finally {
    await rm(job, { recursive: true, force: true });
  }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BYTES) {
        reject(new HttpError(413, "too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function reply(response, status, text, headers = {}) {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...headers });
  response.end(text);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method === "GET" && url.pathname === "/health") return reply(response, 200, "ok");
  if (request.method !== "POST" || url.pathname !== "/convert") return reply(response, 404, "not found");
  if (!authorized(request.headers["x-convert-secret"])) return reply(response, 401, "unauthorized");
  const ext = url.searchParams.get("ext") ?? "";
  if (!EXTENSIONS.has(ext)) return reply(response, 415, "unsupported");
  if (Number(request.headers["content-length"] || 0) > MAX_BYTES) return reply(response, 413, "too large");
  if (!hasRoom()) return reply(response, 503, "busy", { "Retry-After": "30" });
  try {
    const input = await readBody(request);
    if (!looksLike(input, ext)) throw new HttpError(415, "not an office file");
    const pdf = await exclusive(() => convert(input, ext));
    response.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": String(pdf.length) });
    response.end(pdf);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (status === 500) console.error("convert failed", error);
    if (!response.headersSent) reply(response, status, error instanceof HttpError ? error.message : "error", status === 503 ? { "Retry-After": "30" } : {});
  }
});

await mkdir(WORK, { recursive: true });
await resetProfile();
server.requestTimeout = TIMEOUT_MS + 60_000;
server.listen(PORT, HOST, () => console.log(`konfa-convert on ${HOST}:${PORT}`));
