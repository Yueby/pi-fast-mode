import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const host = process.env.PI_FAST_MODE_TEST_HOST;
if (!host) throw new Error("Set PI_FAST_MODE_TEST_HOST to the installed Pi package directory.");

test("OpenAI HTTP serialization respects Fast OFF with inherited priority", async () => {
  const { stream } = await import(pathToFileURL(resolve(host, "../pi-ai/dist/api/openai-responses.js")).href);
  const project = process.env.PI_FAST_MODE_TEST_PACKAGE_DIR ?? dirname(dirname(fileURLToPath(import.meta.url)));
  const { registerFastMode } = await import(pathToFileURL(join(project, "src/index.ts")).href);
  const handlers = new Map();
  const commands = new Map();
  const model = {
    provider: "cpa", id: "arbitrary-alias", name: "Offline fixture", api: "openai-responses",
    baseUrl: "https://example.invalid/v1", input: ["text"], reasoning: false,
    contextWindow: 128000, maxTokens: 1024, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  };
  let chosenScope = new Set();
  const ctx = {
    mode: "tui", model,
    modelRegistry: { getAll: () => [model] },
    ui: { setStatus() {}, notify() {}, custom: async () => chosenScope },
  };
  registerFastMode(
    { on: (name, handler) => handlers.set(name, handler), registerCommand: (name, command) => commands.set(name, command) },
    { load: () => new Map(), save: (provider, scope) => scope === null ? new Map() : new Map([[provider, scope]]) },
  );
  await handlers.get("session_start")({}, ctx);
  const command = (action) => commands.get("fast").handler(action, ctx);
  const captures = [];

  async function capture(options = {}, afterHook, beforeResponse) {
    let wire;
    const result = await stream(model, { messages: [{ role: "user", content: "offline fixture", timestamp: 0 }] }, {
      ...options,
      apiKey: "test-only-not-a-real-key", maxRetries: options.maxRetries ?? 0,
      onPayload: async (params) => {
        const replacement = await handlers.get("before_provider_request")({ payload: params }, ctx);
        const next = replacement ?? params;
        return afterHook ? afterHook(next) : next;
      },
      // No network is used: capture the actual SDK-serialized body and return synthetic SSE.
      fetch: async (_url, init) => {
        wire = JSON.parse(init.body);
        captures.push(wire);
        const override = await beforeResponse?.(wire);
        if (override) return override;
        const completed = {
          type: "response.completed",
          response: { id: "offline", status: "completed", output: [], service_tier: wire.service_tier, usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } },
        };
        return new Response(`event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`, {
          status: 200, headers: { "content-type": "text/event-stream" },
        });
      },
    }).result();
    assert.notEqual(result.stopReason, "error", result.errorMessage);
    assert.ok(wire);
    return wire;
  }

  assert.equal((await capture()).service_tier, "default");
  await command("on");
  assert.equal((await capture({ serviceTier: "default" })).service_tier, "priority");
  await command("off");
  assert.equal((await capture()).service_tier, "default");
  assert.equal((await capture({ serviceTier: "priority" })).service_tier, "default");
  await command("on");
  await command("models"); // Empty scope excludes the still-requested-ON model.
  assert.equal((await capture({ serviceTier: "priority" })).service_tier, "default");

  // A later transform may replace the selected tier.
  assert.equal((await capture({}, (body) => ({ ...body, service_tier: "priority" }))).service_tier, "priority");
  // An already-built ON request can be retried after OFF with its original body.
  chosenScope = null;
  await command("models");
  await command("on");
  let attempts = 0;
  const retried = await capture({ maxRetries: 1 }, undefined, async () => {
    if (++attempts === 1) {
      await command("off");
      return new Response(JSON.stringify({ error: { message: "offline retry fixture", type: "server_error" } }), {
        status: 503, headers: { "content-type": "application/json", "retry-after-ms": "0" },
      });
    }
  });
  assert.equal(attempts, 2);
  assert.equal(retried.service_tier, "priority");
  assert.equal((await capture()).service_tier, "default");

  assert.equal(captures.length, 9);
});
