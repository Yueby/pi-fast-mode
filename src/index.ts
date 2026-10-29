import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { openModelScopeDialog } from "./model-scope-dialog.ts";
import { createScopeStore, type ProviderScopes, type ScopeStore } from "./scope-store.ts";

const STATUS_KEY = "pi-fast-mode";

type SelectedModel = Pick<NonNullable<ExtensionContext["model"]>, "provider" | "id">;

function modelKey(model: SelectedModel | undefined): string | undefined {
  return model ? JSON.stringify([model.provider, model.id]) : undefined;
}

export function scopeConfigPath(agentDir = process.env.PI_CODING_AGENT_DIR, home = homedir()): string {
  const directory = !agentDir ? join(home, ".pi", "agent")
    : agentDir === "~" ? home
    : agentDir.startsWith("~/") || agentDir.startsWith("~\\") ? join(home, agentDir.slice(2))
    : agentDir;
  return join(directory, "extensions", "pi-fast-mode", "config.json");
}

export default function fastMode(pi: ExtensionAPI): void {
  registerFastMode(pi, createScopeStore(scopeConfigPath()));
}

export function registerFastMode(pi: ExtensionAPI, store: ScopeStore): void {
  // Only model scopes are persisted; enabling priority always requires a session command.
  const enabledModels = new Set<string>();
  let providerScopes: ProviderScopes = new Map();
  let scopesReady = false;

  function loadScopes(ctx: ExtensionContext): boolean {
    try {
      providerScopes = store.load();
      scopesReady = true;
      return true;
    } catch (error) {
      scopesReady = false;
      ctx.ui.notify(
        `Could not load Fast mode model scopes. Fast mode is disabled until the config is readable. ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      return false;
    }
  }

  function isModelInScope(model: SelectedModel | undefined): boolean {
    if (!model) return false;
    const scope = providerScopes.get(model.provider);
    if (scope === undefined || scope === null) return true;
    return scope.has(model.id);
  }

  function isModelEffectiveFast(model: SelectedModel | undefined): boolean {
    if (!model || !scopesReady) return false;
    const key = modelKey(model);
    return Boolean(key && enabledModels.has(key) && isModelInScope(model));
  }

  function updateStatus(ctx: ExtensionContext, model = ctx.model): void {
    ctx.ui.setStatus(
      STATUS_KEY,
      ctx.mode === "tui" && isModelEffectiveFast(model) ? "⚡ fast" : undefined,
    );
  }

  pi.on("session_start", (_event, ctx) => {
    enabledModels.clear();
    loadScopes(ctx);
    updateStatus(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    enabledModels.clear();
    providerScopes.clear();
    scopesReady = false;
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.on("model_select", (event, ctx) => {
    updateStatus(ctx, event.model);
  });

  pi.registerCommand("fast", {
    description: "Toggle priority for the current provider/model or configure scope: /fast [on|off|status|models]",
    getArgumentCompletions: (prefix) => {
      const options = ["on", "off", "status", "models"];
      const p = prefix.trim().toLowerCase();
      const matched = options.filter((opt) => opt.startsWith(p));
      return matched.length ? matched.map((v) => ({ value: v, label: v })) : null;
    },
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (!["", "on", "off", "status", "models"].includes(action)) {
        ctx.ui.notify("Usage: /fast [on|off|status|models]", "warning");
        return;
      }

      if (!scopesReady && !loadScopes(ctx)) return;

      if (action === "models") {
        if (ctx.mode !== "tui") {
          ctx.ui.notify("/fast models requires interactive TUI mode.", "warning");
          return;
        }
        if (!ctx.model) {
          ctx.ui.notify("Select a model before configuring model scope.", "warning");
          return;
        }

        const provider = ctx.model.provider;
        const currentScope = providerScopes.get(provider);
        const result = await openModelScopeDialog(ctx, currentScope);

        if (result === undefined) {
          ctx.ui.notify("Model scope configuration cancelled.", "info");
          return;
        }

        try {
          // Commit to disk before changing the active scope or reporting success.
          providerScopes = store.save(provider, result);
        } catch (error) {
          ctx.ui.notify(
            `Could not save Fast mode model scope. Active scope unchanged. ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
          return;
        }
        updateStatus(ctx);

        if (result === null) {
          ctx.ui.notify(
            `Fast mode scope: unrestricted for provider "${provider}" (all models allowed).`,
            "info"
          );
        } else if (result.size === 0) {
          ctx.ui.notify(
            `Fast mode scope: 0 models selected for provider "${provider}" (Fast mode blocked for all models in this provider).`,
            "warning"
          );
        } else {
          ctx.ui.notify(
            `Fast mode scope: restricted to ${result.size} model(s) for provider "${provider}".`,
            "info"
          );
        }
        return;
      }

      const key = modelKey(ctx.model);
      if (!key || !ctx.model) {
        ctx.ui.notify("Select a model before using /fast.", "warning");
        return;
      }

      if (action === "status") {
        const enabled = Boolean(key && enabledModels.has(key));
        const inScope = isModelInScope(ctx.model);
        const scope = providerScopes.get(ctx.model.provider);

        let scopeDesc: string;
        if (scope === undefined || scope === null) {
          scopeDesc = "all models allowed (unrestricted)";
        } else if (scope.size === 0) {
          scopeDesc = "no models allowed (0 selected)";
        } else {
          scopeDesc = `${scope.size} model(s) selected [${inScope ? "in scope" : "excluded"}]`;
        }

        if (enabled && inScope) {
          ctx.ui.notify(
            `Fast mode ON for ${ctx.model.provider}/${ctx.model.id}. Scope: ${scopeDesc}. Requests ask for priority processing; extra charges may apply.`,
            "info"
          );
        } else if (enabled && !inScope) {
          ctx.ui.notify(
            `Fast mode is requested ON for ${ctx.model.provider}/${ctx.model.id}, but this model is currently excluded by provider model scope (/fast models). Scope: ${scopeDesc}. Requests will not inject priority.`,
            "warning"
          );
        } else {
          ctx.ui.notify(
            `Fast mode OFF for ${ctx.model.provider}/${ctx.model.id}. Scope: ${scopeDesc}.`,
            "info"
          );
        }
        return;
      }

      const currentlyEnabled = Boolean(key && enabledModels.has(key));
      const enable = action === "on" || (action === "" && !currentlyEnabled);

      if (enable) {
        enabledModels.add(key);
      } else {
        enabledModels.delete(key);
      }

      const nowEnabled = enabledModels.has(key);
      const inScope = isModelInScope(ctx.model);
      updateStatus(ctx);

      if (nowEnabled) {
        if (inScope) {
          ctx.ui.notify(
            `Fast mode ON for ${ctx.model.provider}/${ctx.model.id}. Requests ask for priority processing; extra charges may apply.`,
            "info"
          );
        } else {
          ctx.ui.notify(
            `Fast mode requested ON for ${ctx.model.provider}/${ctx.model.id}, but this model is currently excluded by provider model scope (/fast models). Requests will not inject priority.`,
            "warning"
          );
        }
      } else {
        ctx.ui.notify(
          `Fast mode OFF for ${ctx.model.provider}/${ctx.model.id}.`,
          "info"
        );
      }
    },
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!isModelEffectiveFast(ctx.model)) return;

    const payload = event.payload;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return;

    return { ...payload, service_tier: "priority" };
  });
}
