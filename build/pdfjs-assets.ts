import { readdirSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";
import { vendorAssets } from "./vendor-assets";

// PDF.js runs in the teacher's browser (lib/document-upload.ts). Its worker and the data it fetches at runtime (image decoders,
// standard fonts, CMaps) are served under /pdfjs/.
const DATA_DIRECTORIES = ["wasm", "standard_fonts", "cmaps"];

function assetFiles(root: string): Map<string, string> {
  const files = new Map<string, string>([["pdf.worker.min.mjs", path.join(root, "legacy", "build", "pdf.worker.min.mjs")]]);
  for (const directory of DATA_DIRECTORIES) {
    for (const name of readdirSync(path.join(root, directory))) files.set(`${directory}/${name}`, path.join(root, directory, name));
  }
  return files;
}

export function pdfjsAssets(): Plugin {
  const root = path.resolve("node_modules", "pdfjs-dist");
  return vendorAssets({ name: "konfa-pdfjs-assets", prefix: "pdfjs", files: () => assetFiles(root) });
}
