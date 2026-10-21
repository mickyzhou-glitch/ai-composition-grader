import { cp, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const root = path.dirname(require.resolve("pdfjs-dist/package.json"));
const target = new URL("../public/pdfjs/", import.meta.url);
await mkdir(target, { recursive: true });
await cp(path.join(root, "build/pdf.worker.min.mjs"), new URL("pdf.worker.min.mjs", target));
for (const directory of ["cmaps", "standard_fonts", "wasm"]) {
  await cp(path.join(root, directory), new URL(`${directory}/`, target), { recursive: true });
}
