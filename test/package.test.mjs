import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packageJson = await readFile(new URL("../package.json", import.meta.url), "utf8")
  .then(JSON.parse)
  .catch(() => null);

test("package manifest exposes the Pi extension", () => {
  assert.ok(packageJson, "package.json must exist");
  assert.equal(packageJson.name, "pi-ds-minimal-mode");
  assert.deepEqual(packageJson.pi?.extensions, ["./extensions/ds-minimal-mode.js"]);
  assert.ok(packageJson.keywords?.includes("pi-package"));
});

test("package manifest declares both target model keywords", () => {
  assert.ok(packageJson.keywords?.includes("deepseek-v4-flash"));
  assert.ok(packageJson.keywords?.includes("deepseek-v4-pro"));
});
