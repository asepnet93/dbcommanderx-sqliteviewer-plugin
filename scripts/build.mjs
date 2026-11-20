import fs from "node:fs";
import path from "node:path";
import esbuild from "esbuild";

const rootDir = path.resolve(import.meta.dirname, "..");
const distDir = path.join(rootDir, "dist");
const mediaSrcDir = path.join(rootDir, "media");
const mediaDistDir = path.join(distDir, "media");

fs.mkdirSync(distDir, { recursive: true });
fs.mkdirSync(mediaDistDir, { recursive: true });

await esbuild.build({
  entryPoints: [path.join(rootDir, "src", "extension.ts")],
  outfile: path.join(distDir, "extension.js"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["vscode"],
  sourcemap: false,
  minify: true
});

// Pure logic bundle for Node unit tests (no vscode dependency)
await esbuild.build({
  entryPoints: [path.join(rootDir, "src", "coreBundle.ts")],
  outfile: path.join(distDir, "coreBundle.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  sourcemap: false,
  minify: false
});

const wasmSrc = path.join(rootDir, "node_modules", "sql.js", "dist", "sql-wasm.wasm");
if (!fs.existsSync(wasmSrc)) {
  throw new Error(`Missing sql-wasm.wasm at ${wasmSrc}`);
}
fs.copyFileSync(wasmSrc, path.join(distDir, "sql-wasm.wasm"));

for (const file of fs.readdirSync(mediaSrcDir)) {
  fs.copyFileSync(path.join(mediaSrcDir, file), path.join(mediaDistDir, file));
}

console.log("Built dist/extension.js, dist/sql-wasm.wasm, and dist/media assets.");
