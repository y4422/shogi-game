// やねうら王 WASM のエンジンファイルを public/ に配置する
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const targets = [
  {
    src: "node_modules/@mizarjp/yaneuraou.k-p/lib",
    dst: "public/engine",
    files: ["yaneuraou.k-p.js", "yaneuraou.k-p.wasm", "yaneuraou.k-p.worker.js"],
  },
];

for (const { src, dst, files } of targets) {
  mkdirSync(join(root, dst), { recursive: true });
  for (const f of files) {
    cpSync(join(root, src, f), join(root, dst, f));
  }
}
cpSync(
  join(root, "node_modules/@mizarjp/yaneuraou.k-p/LICENSE.md"),
  join(root, "public/engine/LICENSE.txt")
);
cpSync(
  join(root, "node_modules/@mizarjp/yaneuraou.k-p/README.md"),
  join(root, "public/engine/README.md")
);
console.log("engine files copied to public/engine/");
