import { test, expect } from "bun:test";
import { safeSecretEqual } from "../auth.js";

test("safeSecretEqual accepts only the exact nonblank secret", () => {
  expect(safeSecretEqual("correct-secret", "correct-secret")).toBe(true);
  expect(safeSecretEqual("wrong-secret", "correct-secret")).toBe(false);
  expect(safeSecretEqual("short", "a-much-longer-secret")).toBe(false);
  expect(safeSecretEqual("", "correct-secret")).toBe(false);
  expect(safeSecretEqual("anything", "")).toBe(false);
  expect(safeSecretEqual(null, "correct-secret")).toBe(false);
  expect(safeSecretEqual("correct-secret", null)).toBe(false);
});

test("safeSecretEqual compares UTF-8 values without throwing", () => {
  expect(safeSecretEqual("管理-token-🔐", "管理-token-🔐")).toBe(true);
  expect(safeSecretEqual("管理-token-🔓", "管理-token-🔐")).toBe(false);
  expect(() => safeSecretEqual("x".repeat(100_000), "expected")).not.toThrow();
});

test("the admin route uses safeSecretEqual and has no direct token equality check", async () => {
  const { readFile } = await import("node:fs/promises");
  const indexText = await readFile(new URL("../index.js", import.meta.url), "utf8");
  expect(indexText).toContain('from "./auth.js"');
  expect(indexText).toContain("safeSecretEqual(token, ADMIN_TOKEN)");
  expect(indexText).not.toMatch(/token\s*!==\s*ADMIN_TOKEN/);
  expect(indexText).not.toMatch(/token\s*===\s*ADMIN_TOKEN/);
});
