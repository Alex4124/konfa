import { readFileSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

// Files a package needs at runtime in the browser (workers, worklets, WebAssembly, data), served from our own site under
// /<prefix>/: straight from node_modules in dev, copied into the client build otherwise.
const CONTENT_TYPES: Record<string, string> = { ".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm" };

// files: the served name (relative to the prefix) → the file on disk.
export function vendorAssets({ name, prefix, files }: { name: string; prefix: string; files: () => Map<string, string> }): Plugin {
  const base = `/${prefix}/`;
  return {
    name,
    configureServer(server) {
      const served = files();
      server.middlewares.use((request, response, next) => {
        const pathname = (request.url ?? "").split("?")[0];
        const file = pathname.startsWith(base) ? served.get(decodeURIComponent(pathname.slice(base.length))) : undefined;
        if (!file) return next();
        response.setHeader("Content-Type", CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream");
        response.end(readFileSync(file));
      });
    },
    generateBundle() {
      if (this.environment?.name !== "client") return;
      for (const [served, file] of files()) this.emitFile({ type: "asset", fileName: `${prefix}/${served}`, source: readFileSync(file) });
    },
  };
}
