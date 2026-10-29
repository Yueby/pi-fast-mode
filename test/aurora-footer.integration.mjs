import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const host = process.env.PI_FAST_MODE_TEST_HOST;
const auroraPath = process.env.PI_FAST_MODE_TEST_FOOTER;
if (!host || !auroraPath) {
  throw new Error("Set PI_FAST_MODE_TEST_HOST to the Pi package directory and PI_FAST_MODE_TEST_FOOTER to aurora-footer.ts.");
}

function plain(text) {
  return text.replace(/\x1b\]8;[^\x1b\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

test("Aurora renders Fast once at the right edge of the bottom path row", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-fast-mode-footer-"));
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  let footer;
  try {
    const { loadExtensions, createExtensionRuntime } = await import(
      pathToFileURL(join(host, "dist/core/extensions/loader.js")).href
    );
    const { visibleWidth } = await import(
      pathToFileURL(resolve(host, "../pi-tui/dist/index.js")).href
    );
    const runtime = createExtensionRuntime();
    runtime.getThinkingLevel = () => "high";
    const project = dirname(dirname(fileURLToPath(import.meta.url)));
    const loaded = await loadExtensions([join(project, "src/index.ts"), auroraPath], project, undefined, runtime);
    assert.deepEqual(loaded.errors, []);
    const fast = loaded.extensions.find((extension) => extension.commands.has("fast"));
    const aurora = loaded.extensions.find((extension) => !extension.commands.has("fast"));
    assert.ok(fast && aurora);

    const statuses = new Map([["other-extension", "watching"]]);
    const theme = { fg: (_color, text) => `\x1b[36m${text}\x1b[0m`, bold: (text) => text };
    const footerData = {
      getExtensionStatuses: () => statuses,
      getAvailableProviderCount: () => 2,
      getGitBranch: () => "main",
      onBranchChange: () => () => {},
    };
    let scopeResult = null;
    const messages = [{ role: "assistant", model: "gpt-physical", thinkingLevel: "medium", stopReason: "stop" }];
    const ctx = {
      mode: "tui", hasUI: true, cwd: join(dir, "project-context"),
      model: { provider: "oauth-relay", id: "renamed-gpt", name: "Alias", api: "openai-responses", reasoning: true },
      modelRegistry: { getAll: () => [ctx.model], isUsingOAuth: () => false },
      getContextUsage: () => ({ percent: 12.5, contextWindow: 1000000 }),
      sessionManager: {
        getCwd: () => ctx.cwd,
        getSessionName: () => "footer-test",
        getSessionId: () => "test-session",
        getLeafId: () => "test-leaf",
        getEntryCount: () => 0,
        getEntries: () => [],
        buildSessionProjection: () => ({ messages }),
      },
      ui: {
        setStatus: (key, text) => text === undefined ? statuses.delete(key) : statuses.set(key, text),
        setWidget: () => { throw new Error("Fast must publish status to the footer"); },
        setFooter: (factory) => { footer = factory({ requestRender() {} }, theme, footerData); },
        onTerminalInput: () => () => {},
        notify() {},
        custom: async () => scopeResult,
      },
    };
    const emit = async (extension, name, event = {}) => {
      for (const handler of extension.handlers.get(name) ?? []) await handler(event, ctx);
    };
    const command = (action) => fast.commands.get("fast").handler(action, ctx);
    await emit(fast, "session_start");
    await emit(aurora, "session_start");
    assert.ok(footer);
    const off = footer.render(200);
    await command("on");
    const on = footer.render(200);
    assert.equal(on.length, off.length, "Fast shares the existing bottom row");
    assert.deepEqual(on.slice(0, -1), off.slice(0, -1), "model and stats rows stay unchanged");
    assert.equal(on.join("\n").match(/⚡ fast/g)?.length, 1);
    assert.match(plain(on.at(-1)), /project-context/);
    assert.match(plain(on.at(-1)), /watching/);
    assert.ok(plain(on.at(-1)).endsWith("⚡ fast"));
    assert.equal(visibleWidth(on.at(-1)), 200);
    assert.equal(statuses.get("other-extension"), "watching");

    for (const width of [0, 1, 2, 8, 20, 50, 80, 120, 200]) {
      const lines = footer.render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width), `footer overflow at width ${width}`);
      if (width >= 10) {
        assert.ok(plain(lines.at(-1)).endsWith("⚡ fast"), `Fast must be on the bottom row at width ${width}`);
      }
    }

    await command("off");
    assert.equal(footer.render(200).join("\n").includes("⚡ fast"), false);
    await command("on");
    scopeResult = new Set();
    await command("models");
    assert.equal(footer.render(200).join("\n").includes("⚡ fast"), false);
    scopeResult = null;
    await command("models");
    assert.ok(plain(footer.render(200).at(-1)).endsWith("⚡ fast"));

    ctx.model = { ...ctx.model, id: "auto", api: "pi-virtual" };
    await emit(fast, "model_select", { model: ctx.model });
    assert.equal(footer.render(200).join("\n").includes("⚡ fast"), false);
    await command("on");
    const routed = plain(footer.render(200).at(-1));
    assert.match(routed, /auto → gpt-physical/);
    assert.ok(routed.endsWith("⚡ fast"));
    await emit(fast, "session_shutdown");
    assert.equal(footer.render(200).join("\n").includes("⚡ fast"), false);
  } finally {
    footer?.dispose?.();
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
});
