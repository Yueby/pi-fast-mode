import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const host = process.env.PI_FAST_MODE_TEST_HOST;
if (!host) throw new Error("Set PI_FAST_MODE_TEST_HOST to the installed Pi package directory.");

test("published extension works with the standard Pi runtime and native model dialog", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-fast-mode-pi-"));
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const { loadExtensions } = await import(pathToFileURL(join(host, "dist/core/extensions/loader.js")).href);
    const { visibleWidth } = await import(pathToFileURL(resolve(host, "../pi-tui/dist/index.js")).href);
    const project = process.env.PI_FAST_MODE_TEST_PACKAGE_DIR ?? dirname(dirname(fileURLToPath(import.meta.url)));
    const statuses = new Map();
    const model = { provider: "custom-oauth-relay", id: "arbitrary-alias", name: "中文模型 🚀", api: "openai-responses" };
    const ctx = {
      mode: "tui", model,
      modelRegistry: { getAll: () => [model, { provider: model.provider, id: "other", name: "另一个模型" }] },
      ui: {
        notify() {},
        setStatus: (key, value) => value === undefined ? statuses.delete(key) : statuses.set(key, value),
        setWidget: () => { throw new Error("Status is owned by the host footer"); },
        custom: async (factory) => {
          let selected;
          const component = await factory(
            { requestRender() {} },
            { fg: (_c, text) => `\x1b[36m${text}\x1b[0m`, bold: (text) => text },
            { matches: () => false },
            (result) => { selected = result; },
          );
          for (const width of [0, 1, 2, 8, 20, 50, 100]) {
            assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
          }
          component.handleInput("n");
          component.handleInput("\x1b[B");
          component.handleInput("\x1b[32u"); // Kitty-encoded Space must toggle the active model.
          component.handleInput("\r");
          assert.deepEqual([...selected], [model.id]);
          return selected;
        },
      },
    };
    const load = async () => {
      const result = await loadExtensions([join(project, "src/index.ts")], project);
      assert.deepEqual(result.errors, []);
      const extension = result.extensions[0];
      for (const handler of extension.handlers.get("session_start") ?? []) await handler({}, ctx);
      return extension;
    };
    const first = await load();
    await first.commands.get("fast").handler("models", ctx);
    const configPath = join(dir, "extensions", "pi-fast-mode", "config.json");
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")).providerScopes[model.provider], [model.id]);
    await first.commands.get("fast").handler("on", ctx);
    assert.equal(statuses.get("pi-fast-mode"), "⚡ fast");
    for (const handler of first.handlers.get("before_provider_request") ?? []) {
      assert.deepEqual(await handler({ payload: { stream: true } }, ctx), { stream: true, service_tier: "priority" });
    }
    const second = await load();
    assert.equal(statuses.get("pi-fast-mode"), undefined);
    await second.commands.get("fast").handler("on", ctx);
    assert.equal(statuses.get("pi-fast-mode"), "⚡ fast");
    ctx.model = { ...model, id: "other" };
    await second.commands.get("fast").handler("on", ctx);
    assert.equal(statuses.get("pi-fast-mode"), undefined);
    for (const handler of second.handlers.get("before_provider_request") ?? []) {
      assert.deepEqual(await handler({ payload: { service_tier: "priority" } }, ctx), { service_tier: "default" });
    }
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
});
