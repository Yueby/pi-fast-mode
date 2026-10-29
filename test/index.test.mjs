import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScopeStore } from "../src/scope-store.ts";
import test from "node:test";
import { registerFastMode, scopeConfigPath } from "../src/index.ts";
import { collectProviderModels, ModelScopeComponent } from "../src/model-scope-dialog.ts";

function makeScopeComponent(options, done, deps = {}) {
  const keys = { up: "\x1b[A", down: "\x1b[B", pageUp: "\x1b[5~", pageDown: "\x1b[6~", home: "\x1b[H", end: "\x1b[F", enter: "\r", escape: "\x1b", "ctrl+c": "\x03", space: " " };
  return new ModelScopeComponent(options, done, {
    truncate: (text, width) => text.slice(0, Math.max(0, width)),
    matchesKey: (data, key) => data === (keys[key] ?? (key.startsWith("shift+") ? key.slice(6).toUpperCase() : key)),
    ...deps,
  });
}

function setup(model = { provider: "my-oauth-relay", id: "gpt-5.4" }, options = {}) {
  const handlers = new Map();
  const commands = new Map();
  const statuses = new Map();
  const widgets = new Map();
  const notifications = [];
  const modelRegistry = options.modelRegistry || {
    getAll: () => [
      { provider: "my-oauth-relay", id: "gpt-5.4", name: "GPT-5.4" },
      { provider: "my-oauth-relay", id: "custom-alias-1", name: "Custom Alias 1" },
      { provider: "my-oauth-relay", id: "claude-custom", name: "Claude Custom" },
      { provider: "other-relay", id: "other-model", name: "Other Model" },
    ],
  };
  let customDialogHandler = options.customDialogHandler || null;

  const ctx = {
    mode: options.mode !== undefined ? options.mode : "tui",
    model,
    modelRegistry,
    ui: {
      setStatus: (key, value) => {
        if (value === undefined) statuses.delete(key);
        else statuses.set(key, value);
      },
      setWidget: (key, content, widgetOptions) => {
        assert.notEqual(key, "pi-fast-mode", "Fast status belongs to the footer");
        if (content === undefined) widgets.delete(key);
        else widgets.set(key, { content, options: widgetOptions });
      },
      notify: (message, level) => notifications.push({ message, level }),
      custom: async (factory) => {
        if (customDialogHandler) {
          return customDialogHandler(factory);
        }
        throw new Error("Test must supply a model-scope dialog result.");
      },
    },
  };

  const pi = {
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
  };

  let savedScopes = new Map();
  const cloneScopes = () => new Map([...savedScopes].map(([provider, ids]) => [provider, new Set(ids)]));
  const store = options.store ?? {
    load: cloneScopes,
    save: (provider, scope) => {
      if (scope === null) savedScopes.delete(provider);
      else savedScopes.set(provider, new Set(scope));
      return cloneScopes();
    },
  };
  registerFastMode(pi, store);
  const emit = async (name, event = {}) => handlers.get(name)?.(event, ctx);

  return {
    ctx,
    handlers,
    commands,
    statuses,
    widgets,
    notifications,
    emit,
    store,
    setCustomDialogHandler: (fn) => {
      customDialogHandler = fn;
    },
    command: (args = "") => commands.get("fast").handler(args, ctx),
    request: (payload) => emit("before_provider_request", { payload }),
    select: async (nextModel) => {
      const previousModel = ctx.model;
      ctx.model = nextModel;
      await emit("model_select", { model: nextModel, previousModel, source: "set" });
    },
  };
}

test("config path uses the user directory and supports agent-dir and tilde overrides", () => {
  const home = join(tmpdir(), "scope-path-home");
  const override = join(tmpdir(), "scope-path-override");
  assert.equal(scopeConfigPath("", home), join(home, ".pi", "agent", "extensions", "pi-fast-mode", "config.json"));
  assert.equal(scopeConfigPath(override, home), join(override, "extensions", "pi-fast-mode", "config.json"));
  assert.equal(scopeConfigPath("~/custom-agent", home), join(home, "custom-agent", "extensions", "pi-fast-mode", "config.json"));
  assert.equal(scopeConfigPath("~\\custom-agent", home), join(home, "custom-agent", "extensions", "pi-fast-mode", "config.json"));
  assert.equal(scopeConfigPath("~", home), join(home, "extensions", "pi-fast-mode", "config.json"));
});

test("package declares the extension entry point and peerDependencies", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.name, "@yueby/pi-fast-mode");
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.publishConfig.access, "public");
  assert.deepEqual(pkg.pi.extensions, ["./src/index.ts"]);
  assert.equal(pkg.peerDependencies["@earendil-works/pi-coding-agent"], "*");
  assert.equal(pkg.peerDependencies["@earendil-works/pi-tui"], "*");
});

test("starts disabled and registers only /fast with completions", async () => {
  const app = setup();
  await app.emit("session_start");
  assert.deepEqual([...app.commands.keys()], ["fast"]);
  assert.deepEqual([...app.handlers.keys()], ["session_start", "session_shutdown", "model_select", "before_provider_request"]);
  assert.equal(await app.request({ model: "gpt-5.4" }), undefined);
  assert.equal(app.statuses.get("pi-fast-mode"), undefined);

  const cmd = app.commands.get("fast");
  assert.deepEqual(cmd.getArgumentCompletions(""), [
    { value: "on", label: "on" },
    { value: "off", label: "off" },
    { value: "status", label: "status" },
    { value: "models", label: "models" },
  ]);
  assert.deepEqual(cmd.getArgumentCompletions("m"), [{ value: "models", label: "models" }]);
});

test("/fast toggles priority for a custom OAuth provider without mutating payload", async () => {
  const app = setup();
  const payload = Object.freeze({ model: "gpt-5.4", input: [{ role: "user", content: "Hi" }], stream: true });
  await app.command();
  const result = await app.request(payload);
  assert.deepEqual(result, { ...payload, service_tier: "priority" });
  assert.notEqual(result, payload);
  assert.equal(result.input, payload.input);
  assert.equal(Object.hasOwn(payload, "service_tier"), false);
  assert.equal(app.statuses.get("pi-fast-mode"), "⚡ fast");
  assert.match(app.notifications.at(-1).message, /extra charges/);
  await app.command();
  assert.equal(await app.request(payload), undefined);
  assert.equal(app.statuses.get("pi-fast-mode"), undefined);
});

test("explicit on/off are idempotent, and status does not toggle", async () => {
  const app = setup();
  for (const action of ["on", "on", "status"]) {
    await app.command(action);
    assert.equal((await app.request({})).service_tier, "priority");
  }
  for (const action of ["off", "off", "status"]) {
    await app.command(action);
    assert.equal(await app.request({}), undefined);
  }
  assert.match(app.notifications.at(-1).message, /OFF/);
});

test("state is isolated by provider and model, and follows model selection", async () => {
  const app = setup();
  const original = app.ctx.model;
  await app.command("on");
  for (const model of [
    { provider: "another-relay", id: original.id },
    { provider: original.provider, id: "another-gpt" },
  ]) {
    await app.select(model);
    assert.equal(await app.request({}), undefined);
    assert.equal(app.statuses.get("pi-fast-mode"), undefined);
  }
  await app.command("on");
  await app.select(original);
  assert.equal((await app.request({})).service_tier, "priority");
  assert.equal(app.statuses.get("pi-fast-mode"), "⚡ fast");
});

test("provider/model keys remain distinct when names contain slashes", async () => {
  const app = setup({ provider: "relay/team", id: "gpt" });
  await app.command("on");
  await app.select({ provider: "relay", id: "team/gpt" });
  assert.equal(await app.request({}), undefined);
});

test("invalid commands and missing model do not enable priority", async () => {
  const app = setup();
  await app.command("invalid");
  assert.equal(await app.request({}), undefined);
  assert.match(app.notifications.at(-1).message, /Usage:/);
  app.ctx.model = undefined;
  await app.command();
  assert.equal(await app.request({}), undefined);
  assert.match(app.notifications.at(-1).message, /Select a model/);
});

test("non-object and array payloads are left unchanged", async () => {
  const app = setup();
  await app.command("on");
  for (const payload of [null, undefined, "body", 42, true, [], () => {}]) {
    assert.equal(await app.request(payload), undefined);
  }
});

test("only enabled requests override an existing service_tier", async () => {
  const app = setup();
  const payload = { service_tier: "flex", stream: true };
  assert.equal(await app.request(payload), undefined);
  await app.command("on");
  assert.deepEqual(await app.request(payload), { service_tier: "priority", stream: true });
  await app.command("off");
  assert.equal(await app.request(payload), undefined);
  assert.equal(payload.service_tier, "flex");
});

test("shutdown and session start reset state, and runtimes are independent", async () => {
  const app = setup();
  await app.command("on");
  assert.equal(await setup().request({}), undefined);
  await app.emit("session_shutdown");
  assert.equal(await app.request({}), undefined);
  assert.equal(app.statuses.get("pi-fast-mode"), undefined);
  await app.command("on");
  await app.emit("session_start");
  assert.equal(await app.request({}), undefined);
  assert.equal(app.statuses.get("pi-fast-mode"), undefined);
});

test("all-by-default allows arbitrary alias/non-GPT models without name filtering", async () => {
  const app = setup({ provider: "my-relay", id: "custom-relay-non-gpt-model" });
  // Default is unrestricted: turns on directly
  await app.command("on");
  const result = await app.request({ stream: true });
  assert.equal(result?.service_tier, "priority");
  assert.equal(app.statuses.get("pi-fast-mode"), "⚡ fast");
  assert.match(app.notifications.at(-1).message, /Fast mode ON/);
});

test("collectProviderModels lists models for current provider only, preserving active and prior IDs", () => {
  const ctx = {
    model: { provider: "my-relay", id: "active-model", name: "Active Model" },
    modelRegistry: {
      getAll: () => [
        { provider: "my-relay", id: "model-1", name: "Model 1" },
        { provider: "foreign-relay", id: "model-foreign", name: "Foreign Model" },
      ],
    },
  };
  const list = collectProviderModels(ctx, "my-relay", new Set(["preserved-prior-id"]));
  const ids = list.map((m) => m.id);
  assert.ok(ids.includes("active-model"));
  assert.ok(ids.includes("model-1"));
  assert.ok(ids.includes("preserved-prior-id"));
  assert.ok(!ids.includes("model-foreign"));
  // Active model is sorted first
  assert.equal(list[0].id, "active-model");
});

test("selected and unselected model filtering when Fast mode is already toggled ON", async () => {
  const app = setup({ provider: "my-relay", id: "model-a" });
  await app.command("on"); // model-a ON

  await app.select({ provider: "my-relay", id: "model-b" });
  await app.command("on"); // model-b ON

  // Now configure scope: only model-a in scope
  app.setCustomDialogHandler(() => Promise.resolve(new Set(["model-a"])));

  await app.command("models");
  assert.match(app.notifications.at(-1).message, /restricted to 1 model/);

  // model-b is currently active, was requested ON, but is excluded
  assert.equal(app.statuses.get("pi-fast-mode"), undefined);
  assert.equal(await app.request({}), undefined);

  // /fast status explains requested ON but excluded
  await app.command("status");
  assert.match(app.notifications.at(-1).message, /requested ON/);
  assert.match(app.notifications.at(-1).message, /excluded by provider model scope/);

  // Switch back to model-a (in scope)
  await app.select({ provider: "my-relay", id: "model-a" });
  assert.equal(app.statuses.get("pi-fast-mode"), "⚡ fast");
  assert.equal((await app.request({})).service_tier, "priority");

  await app.command("status");
  assert.match(app.notifications.at(-1).message, /Fast mode ON/);
  assert.match(app.notifications.at(-1).message, /in scope/);
});

test("provider scope isolation: restricting one provider leaves other providers unrestricted", async () => {
  const app = setup({ provider: "relay-1", id: "m1" });
  await app.command("on");

  // Restrict relay-1 to empty or specific
  app.setCustomDialogHandler(() => Promise.resolve(new Set(["m-other"])));
  await app.command("models");

  // relay-1/m1 is now excluded
  assert.equal(app.statuses.get("pi-fast-mode"), undefined);
  assert.equal(await app.request({}), undefined);

  // Switch to relay-2 (unrestricted by default)
  await app.select({ provider: "relay-2", id: "m2" });
  await app.command("on");
  assert.equal(app.statuses.get("pi-fast-mode"), "⚡ fast");
  assert.equal((await app.request({})).service_tier, "priority");
});

test("cancel in model scope dialog preserves previous scope", async () => {
  const app = setup({ provider: "my-relay", id: "m1" });
  await app.command("on");

  // Restrict scope to m1
  app.setCustomDialogHandler(() => Promise.resolve(new Set(["m1"])));
  await app.command("models");
  assert.equal(app.statuses.get("pi-fast-mode"), "⚡ fast");

  // Open dialog and cancel (returns undefined)
  app.setCustomDialogHandler(() => Promise.resolve(undefined));
  await app.command("models");
  assert.match(app.notifications.at(-1).message, /cancelled/);

  // Scope remains intact: m1 still injects
  assert.equal(app.statuses.get("pi-fast-mode"), "⚡ fast");
  assert.equal((await app.request({})).service_tier, "priority");
});

test("restore all (unrestricted) in model scope dialog clears restrictions", async () => {
  const app = setup({ provider: "my-relay", id: "m1" });
  await app.command("on");

  // Restrict to m2
  app.setCustomDialogHandler(() => Promise.resolve(new Set(["m2"])));
  await app.command("models");
  assert.equal(app.statuses.get("pi-fast-mode"), undefined);

  // Now restore all (null)
  app.setCustomDialogHandler(() => Promise.resolve(null));
  await app.command("models");
  assert.match(app.notifications.at(-1).message, /unrestricted/);

  // m1 is active again
  assert.equal(app.statuses.get("pi-fast-mode"), "⚡ fast");
  assert.equal((await app.request({})).service_tier, "priority");
});

test("empty selection (0 models) disables Fast mode for all models in provider", async () => {
  const app = setup({ provider: "my-relay", id: "m1" });
  await app.command("on");

  // Save empty set
  app.setCustomDialogHandler(() => Promise.resolve(new Set()));
  await app.command("models");
  assert.match(app.notifications.at(-1).message, /0 models selected/);

  // Even though m1 was toggled ON, it is blocked
  assert.equal(app.statuses.get("pi-fast-mode"), undefined);
  assert.equal(await app.request({}), undefined);

  // Toggling or turning on also reports warning
  await app.command("on");
  assert.match(app.notifications.at(-1).message, /excluded by provider model scope/);
  assert.equal(await app.request({}), undefined);
});

test("non-TUI mode and missing model guards for /fast models", async () => {
  const app = setup({ provider: "my-relay", id: "m1" }, { mode: "cli" });
  let customCalled = false;
  app.setCustomDialogHandler(() => {
    customCalled = true;
    return Promise.resolve(null);
  });

  await app.command("models");
  assert.equal(customCalled, false);
  assert.match(app.notifications.at(-1).message, /requires interactive TUI mode/);

  app.ctx.mode = "tui";
  app.ctx.model = undefined;
  await app.command("models");
  assert.equal(customCalled, false);
  assert.match(app.notifications.at(-1).message, /Select a model/);
});

test("session reset restores model scopes but clears enabled toggles", async () => {
  const app = setup({ provider: "my-relay", id: "m1" });
  await app.command("on");
  app.setCustomDialogHandler(() => Promise.resolve(new Set(["m1"])));
  await app.command("models");

  assert.equal(app.statuses.get("pi-fast-mode"), "⚡ fast");

  // Reset via session_shutdown
  await app.emit("session_shutdown");
  assert.equal(app.statuses.get("pi-fast-mode"), undefined);
  assert.equal(await app.request({}), undefined);

  // The saved scope is restored, while Fast mode remains OFF.
  await app.emit("session_start");
  await app.command("status");
  assert.match(app.notifications.at(-1).message, /OFF/);
  assert.match(app.notifications.at(-1).message, /1 model\(s\) selected/);
  assert.equal(await app.request({}), undefined);
  await app.command("on");
  assert.equal((await app.request({})).service_tier, "priority");
  await app.select({ provider: "my-relay", id: "m2" });
  await app.command("on");
  assert.equal(await app.request({}), undefined);
});

test("saved disk scope survives a new runtime while Fast remains OFF", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-fast-mode-runtime-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "config.json");
  const model = { provider: "custom-oauth", id: "alias-a" };
  const first = setup(model, { store: createScopeStore(path) });
  await first.command("on");
  first.setCustomDialogHandler(() => Promise.resolve(new Set(["alias-b"])));
  await first.command("models");
  assert.equal(await first.request({}), undefined);

  const second = setup(model, { store: createScopeStore(path) });
  await second.emit("session_start");
  await second.command("status");
  assert.match(second.notifications.at(-1).message, /OFF/);
  assert.match(second.notifications.at(-1).message, /excluded/);
  await second.command("on");
  assert.equal(await second.request({}), undefined);
  await second.select({ provider: "custom-oauth", id: "alias-b" });
  assert.equal(await second.request({}), undefined);
  await second.command("on");
  assert.equal((await second.request({})).service_tier, "priority");

  const beforeCancel = readFileSync(path, "utf8");
  second.setCustomDialogHandler(() => Promise.resolve(undefined));
  await second.command("models");
  assert.equal(readFileSync(path, "utf8"), beforeCancel);
});

test("cancel and normal Fast toggles do not write settings", async () => {
  let writes = 0;
  const app = setup(undefined, {
    store: { load: () => new Map(), save: () => { writes++; return new Map(); } },
  });
  await app.command("on");
  await app.command("status");
  await app.command("off");
  app.setCustomDialogHandler(() => Promise.resolve(undefined));
  await app.command("models");
  assert.equal(writes, 0);
});

test("failed save reports an error and preserves the active scope", async () => {
  const model = { provider: "relay", id: "m1" };
  const app = setup(model, {
    store: {
      load: () => new Map([["relay", new Set(["m1"])]]),
      save: () => { throw new Error("Permission denied"); },
    },
  });
  await app.command("on");
  app.setCustomDialogHandler(() => Promise.resolve(new Set()));
  await app.command("models");
  assert.equal(app.notifications.at(-1).level, "error");
  assert.match(app.notifications.at(-1).message, /Active scope unchanged/);
  assert.equal(app.statuses.get("pi-fast-mode"), "⚡ fast");
  assert.equal((await app.request({})).service_tier, "priority");
});

test("failed load blocks Fast until config can be read", async () => {
  let broken = true;
  let writes = 0;
  const app = setup(undefined, {
    store: {
      load: () => { if (broken) throw new Error("Invalid config"); return new Map(); },
      save: () => { writes++; return new Map(); },
    },
  });
  await app.emit("session_start");
  assert.equal(app.notifications.at(-1).level, "error");
  await app.command("on");
  assert.equal(await app.request({}), undefined);
  assert.equal(app.statuses.get("pi-fast-mode"), undefined);
  assert.equal(writes, 0);
  broken = false;
  await app.command("on");
  assert.equal((await app.request({})).service_tier, "priority");
  assert.equal(app.statuses.get("pi-fast-mode"), "⚡ fast");
});

test("ModelScopeComponent interactive rendering and key navigation", () => {
  const models = [
    { id: "m1", name: "Model One" },
    { id: "m2", name: "Model Two" },
    { id: "m3", name: "Model Three" },
  ];

  let doneResult = Symbol("none");
  const comp = makeScopeComponent(
    {
      provider: "test-provider",
      activeModelId: "m1",
      models,
      initialScope: null, // unrestricted
    },
    (res) => {
      doneResult = res;
    },
    {
      maxVisible: 5,
    }
  );

  // 1. Initial render
  const lines = comp.render(80);
  assert.ok(lines.some((l) => l.includes("⚡ Fast Mode — Model Scope")));
  assert.ok(lines.some((l) => l.includes("test-provider")));
  assert.ok(lines.some((l) => l.includes("🌐 Mode: Unrestricted")));
  assert.ok(lines.some((l) => l.includes("Model One (m1) (current 📍)")));

  // 2. Space on row 0 toggles unrestricted mode off
  comp.handleInput(" ");
  assert.equal(comp.getState().isUnrestricted, false);

  // 3. Move down to m1 and space (toggle m1 off)
  comp.handleInput("j");
  assert.equal(comp.getState().selectedIndex, 1);
  comp.handleInput(" ");
  assert.equal(comp.getState().selectedIds.has("m1"), false);

  // 4. Test 'a' selects all specific models
  comp.handleInput("a");
  assert.equal(comp.getState().selectedIds.size, 3);
  assert.equal(comp.getState().isUnrestricted, false);

  // 5. Test 'n' deselects all models
  comp.handleInput("n");
  assert.equal(comp.getState().selectedIds.size, 0);
  assert.equal(comp.getState().isUnrestricted, false);
  const noneLines = comp.render(80);
  assert.ok(noneLines.some((l) => l.includes("🚫 Mode: No models selected")));

  // 6. Test 'u' restores unrestricted mode
  comp.handleInput("u");
  assert.equal(comp.getState().isUnrestricted, true);
  const uLines = comp.render(80);
  assert.ok(uLines.some((l) => l.includes("🌐 Mode: Unrestricted")));

  // 7. Test confirm with Enter on unrestricted
  comp.handleInput("\r");
  assert.equal(doneResult, null);

  // 8. Test confirm with restricted set
  let res2;
  const comp2 = makeScopeComponent(
    {
      provider: "test-provider",
      activeModelId: "m1",
      models,
      initialScope: new Set(["m2"]),
    },
    (r) => {
      res2 = r;
    }
  );
  assert.equal(comp2.getState().isUnrestricted, false);
  assert.equal(comp2.getState().selectedIds.has("m2"), true);
  comp2.handleInput("\r");
  assert.ok(res2 instanceof Set);
  assert.deepEqual([...res2], ["m2"]);

  // 9. Test cancel with Escape
  let res3 = Symbol("none");
  const comp3 = makeScopeComponent(
    { provider: "p", models, initialScope: null },
    (r) => {
      res3 = r;
    }
  );
  comp3.handleInput("\u001b");
  assert.equal(res3, undefined);

  // 10. Test scroll indicators with many models
  const manyModels = Array.from({ length: 15 }, (_, i) => ({ id: `id-${i}`, name: `Name ${i}` }));
  const compMany = makeScopeComponent(
    { provider: "p", models: manyModels, initialScope: null },
    () => {},
    { maxVisible: 4 }
  );
  // Initially cursor at 0
  const initialMany = compMany.render(60);
  assert.ok(initialMany.some((l) => l.includes("more below")));

  // Move down past visible range
  for (let i = 0; i < 7; i++) compMany.handleInput("j");
  const scrolledMany = compMany.render(60);
  assert.ok(scrolledMany.some((l) => l.includes("more above")));
});

test("OpenAI OFF and excluded scopes force default even when input is priority", async () => {
  const app = setup({ provider: "cpa", id: "alias", api: "openai-responses" });
  await app.emit("session_start");
  const payload = Object.freeze({ service_tier: "priority", stream: true });
  assert.deepEqual(await app.request(payload), { service_tier: "default", stream: true });
  await app.command("on");
  assert.equal((await app.request(payload)).service_tier, "priority");
  await app.command("off");
  assert.equal((await app.request(payload)).service_tier, "default");
  assert.match(app.notifications.at(-1).message, /service_tier=default/);
  await app.command("on");
  app.setCustomDialogHandler(() => Promise.resolve(new Set()));
  await app.command("models");
  assert.equal((await app.request(payload)).service_tier, "default");
  assert.equal(app.statuses.get("pi-fast-mode"), undefined);
  assert.equal(payload.service_tier, "priority");
});

test("unreadable scopes still force default on OpenAI requests", async () => {
  const app = setup({ provider: "cpa", id: "alias", api: "openai-responses" }, {
    store: { load: () => { throw new Error("Invalid config"); }, save: () => { throw new Error("must not save"); } },
  });
  await app.emit("session_start");
  assert.equal((await app.request({ service_tier: "priority" })).service_tier, "default");
});

test("footer status follows TUI and non-TUI mode transitions", async () => {
  const app = setup({ provider: "my-relay", id: "m1" }, { mode: "tui" });
  await app.command("on");
  assert.equal(app.statuses.get("pi-fast-mode"), "⚡ fast");

  // Transition to non-TUI (e.g. CLI or JSON mode)
  app.ctx.mode = "json";
  await app.select({ provider: "my-relay", id: "m1" });
  assert.equal(app.statuses.get("pi-fast-mode"), undefined);

  // Transition back to TUI
  app.ctx.mode = "tui";
  await app.select({ provider: "my-relay", id: "m1" });
  assert.equal(app.statuses.get("pi-fast-mode"), "⚡ fast");
});

test("Fast status coexists with other extension statuses and widgets", async () => {
  const app = setup();
  // Another extension set its status and its own widget
  app.ctx.ui.setStatus("other-extension", "running");
  app.ctx.ui.setWidget("other-widget", ["other widget content"]);

  await app.command("on");
  assert.equal(app.statuses.get("pi-fast-mode"), "⚡ fast");
  // Other extension's status and widget are completely untouched
  assert.equal(app.statuses.get("other-extension"), "running");
  assert.equal(app.widgets.has("other-widget"), true);
  await app.command("off");
  assert.equal(app.statuses.get("pi-fast-mode"), undefined);
  assert.equal(app.statuses.get("other-extension"), "running");
  assert.equal(app.widgets.has("other-widget"), true);
});
