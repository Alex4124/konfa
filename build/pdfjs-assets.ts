import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

// PDF.js runs in the teacher's browser (lib/document-upload.ts). Its worker and the data it fetches at runtime (image decoders,
// standard fonts, CMaps) are served under /pdfjs/: straight from node_modules in dev, copied into the client build otherwise.
const DATA_DIRECTORIES = ["wasm", "standard_fonts", "cmaps"];

const CONTENT_TYPES: Record<string, string> = { ".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm" };

function assetFiles(root: string): Map<string, string> {
  const files = new Map<string, string>([["pdf.worker.min.mjs", path.join(root, "legacy", "build", "pdf.worker.min.mjs")]]);
  for (const directory of DATA_DIRECTORIES) {
    for (const name of readdirSync(path.join(root, directory))) files.set(`${directory}/${name}`, path.join(root, directory, name));
  }
  return files;
}

export function pdfjsAssets(): Plugin {
  const root = path.resolve("node_modules", "pdfjs-dist");
  return {
    name: "konfa-pdfjs-assets",
    configureServer(server) {
      const files = assetFiles(root);
      server.middlewares.use((request, response, next) => {
        const pathname = (request.url ?? "").split("?")[0];
        const file = pathname.startsWith("/pdfjs/") ? files.get(decodeURIComponent(pathname.slice("/pdfjs/".length))) : undefined;
        if (!file) return next();
        response.setHeader("Content-Type", CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream");
        response.end(readFileSync(file));
      });
    },
    generateBundle() {
      if (this.environment?.name !== "client") return;
      for (const [name, file] of assetFiles(root)) this.emitFile({ type: "asset", fileName: `pdfjs/${name}`, source: readFileSync(file) });
    },
  };
}
