import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createScopeStore } from "../src/scope-store.ts";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-fast-mode-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "config.json");
  return { dir, path, store: createScopeStore(path) };
}

test("missing config means unrestricted and does not create a file", (t) => {
  const { path, store } = fixture(t);
  assert.equal(store.load().size, 0);
  assert.equal(existsSync(path), false);
});

test("saved exact model aliases are restored by a new store instance", (t) => {
  const { path, store } = fixture(t);
  store.save("oauth-relay", new Set(["alias/gpt", "任意别名"]));
  assert.deepEqual([...createScopeStore(path).load().get("oauth-relay")], ["alias/gpt", "任意别名"]);
  const json = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(json, { version: 1, providerScopes: { "oauth-relay": ["alias/gpt", "任意别名"] } });
});

test("empty selection is preserved as a restricted empty scope", (t) => {
  const { path, store } = fixture(t);
  store.save("relay", new Set());
  const scopes = createScopeStore(path).load();
  assert.equal(scopes.has("relay"), true);
  assert.equal(scopes.get("relay").size, 0);
});

test("restoring unrestricted removes only the current provider entry", (t) => {
  const { path, store } = fixture(t);
  store.save("relay-a", new Set(["m1"]));
  store.save("relay-b", new Set());
  store.save("relay-a", null);
  const scopes = createScopeStore(path).load();
  assert.equal(scopes.has("relay-a"), false);
  assert.equal(scopes.has("relay-b"), true);
  assert.equal(scopes.get("relay-b").size, 0);
});

test("save re-reads disk and retains changes to other providers", (t) => {
  const { path, store: first } = fixture(t);
  const second = createScopeStore(path);
  first.save("relay-a", new Set(["same-id"]));
  second.load();
  first.save("relay-b", new Set(["same-id"]));
  second.save("relay-a", new Set(["new-id"]));
  const scopes = first.load();
  assert.deepEqual([...scopes.get("relay-a")], ["new-id"]);
  assert.deepEqual([...scopes.get("relay-b")], ["same-id"]);
});

test("invalid JSON and invalid schema are reported and never overwritten", (t) => {
  const { path, store } = fixture(t);
  const invalid = [
    "{broken", "null", "[]", "{}",
    JSON.stringify({ version: 2, providerScopes: {} }),
    JSON.stringify({ version: 1, providerScopes: [] }),
    JSON.stringify({ version: 1, providerScopes: { relay: null } }),
    JSON.stringify({ version: 1, providerScopes: { relay: [42] } }),
    JSON.stringify({ version: 1, providerScopes: { relay: [""] } }),
  ];
  for (const raw of invalid) {
    writeFileSync(path, raw);
    assert.throws(() => store.load(), /Invalid/);
    assert.throws(() => store.save("relay", new Set(["m1"])), /Invalid/);
    assert.equal(readFileSync(path, "utf8"), raw);
  }
});

test("unreadable config is not treated as missing", (t) => {
  const { path, store } = fixture(t);
  mkdirSync(path);
  assert.throws(() => store.load());
  assert.throws(() => store.save("relay", new Set(["m1"])));
});

test("provider names remain literal even for object prototype names", (t) => {
  const { path, store } = fixture(t);
  store.save("__proto__", new Set(["m1"]));
  store.save("constructor", new Set(["m2"]));
  const scopes = createScopeStore(path).load();
  assert.deepEqual([...scopes.get("__proto__")], ["m1"]);
  assert.deepEqual([...scopes.get("constructor")], ["m2"]);
});

test("successful updates replace valid config and clean transaction files", (t) => {
  const { dir, store } = fixture(t);
  store.save("relay", new Set(["m1"]));
  store.save("relay", new Set(["m2"]));
  assert.deepEqual([...store.load().get("relay")], ["m2"]);
  assert.deepEqual(readdirSync(dir), ["config.json"]);
});
