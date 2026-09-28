// Fails the build when the shipped JS + CSS exceed the gzipped budget.
// Audio, images and fonts are deliberately outside the budget: they load
// lazily or not at all, and never block first paint.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const BUDGET_BYTES = 60 * 1024;
const dist = fileURLToPath(new URL("../dist/", import.meta.url));

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(js|css)$/.test(entry)) out.push(full);
  }
  return out;
}

let files;
try {
  files = walk(dist);
} catch {
  console.error(`No build found at ${dist}. Run \`npm run build\` first.`);
  process.exit(1);
}

let total = 0;
const rows = files.map((file) => {
  const raw = readFileSync(file);
  const gz = gzipSync(raw).length;
  total += gz;
  return { file: relative(dist, file), raw: raw.length, gz };
});

const kb = (n) => `${(n / 1024).toFixed(2)} KB`;
for (const row of rows) {
  console.log(`${row.file.padEnd(40)} ${kb(row.raw).padStart(10)} raw ${kb(row.gz).padStart(10)} gz`);
}
console.log(`${"total (gzipped)".padEnd(40)} ${"".padStart(14)} ${kb(total).padStart(10)} / ${kb(BUDGET_BYTES)}`);

if (total > BUDGET_BYTES) {
  console.error(`Bundle exceeds budget by ${kb(total - BUDGET_BYTES)}.`);
  process.exit(1);
}
