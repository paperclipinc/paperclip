import { readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { generateDrizzleJson } from "drizzle-kit/api";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const migrationsDir = path.join(__dirname, "src/migrations");
const schemaDir = path.join(__dirname, "src/schema");

const journal = JSON.parse(await readFile(path.join(migrationsDir, "meta", "_journal.json"), "utf8"));
const newest = journal.entries.at(-1);
const snapshotFile = `${String(newest.idx).padStart(4, "0")}_snapshot.json`;
const snapshotPath = path.join(migrationsDir, "meta", snapshotFile);

console.log(`Newest entry: idx=${newest.idx} tag=${newest.tag}`);
console.log(`Snapshot file: ${snapshotFile}`);

const existingSnapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
console.log(`Existing snapshot tables: ${Object.keys(existingSnapshot.tables).length}`);

const files = (await readdir(schemaDir)).filter(f => f.endsWith(".ts")).sort();
const exports = {};
const seen = new Set();
for (const file of files) {
  const module = await import(pathToFileURL(path.join(schemaDir, file)).href);
  for (const [name, value] of Object.entries(module)) {
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) continue;
      seen.add(value);
    }
    exports[`${file}#${name}`] = value;
  }
}

const newSnapshot = generateDrizzleJson(exports, existingSnapshot.id);
newSnapshot.prevId = existingSnapshot.prevId;

console.log(`New snapshot tables: ${Object.keys(newSnapshot.tables).length}`);

await writeFile(snapshotPath, JSON.stringify(newSnapshot, null, 2));
console.log(`Wrote ${snapshotPath}`);
