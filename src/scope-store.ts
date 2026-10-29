import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type ProviderScopes = Map<string, Set<string>>;

export interface ScopeStore {
  load(): ProviderScopes;
  save(provider: string, scope: Set<string> | null): ProviderScopes;
}

function parseScopes(value: unknown): ProviderScopes {
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    !("version" in value) || value.version !== 1 ||
    !("providerScopes" in value) || value.providerScopes === null ||
    typeof value.providerScopes !== "object" || Array.isArray(value.providerScopes)
  ) {
    throw new Error("Invalid model scope config: expected version 1 and providerScopes object.");
  }

  const scopes: ProviderScopes = new Map();
  for (const [provider, ids] of Object.entries(value.providerScopes)) {
    if (!provider || !Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !id)) {
      throw new Error("Invalid model scope config: each provider must contain an array of model IDs.");
    }
    scopes.set(provider, new Set(ids));
  }
  return scopes;
}

export function createScopeStore(configPath: string): ScopeStore {
  function load(): ProviderScopes {
    let raw: string;
    try {
      raw = readFileSync(configPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error(`Invalid JSON in model scope config: ${configPath}`);
    }
    return parseScopes(value);
  }

  return {
    load,
    save(provider, scope) {
      // Re-read before saving to retain other providers edited by another session.
      // Invalid existing config is never replaced with defaults.
      const scopes = load();
      if (scope === null) scopes.delete(provider);
      else scopes.set(provider, new Set(scope));

      const config = {
        version: 1,
        providerScopes: Object.fromEntries(
          [...scopes].map(([name, ids]) => [name, [...ids]]),
        ),
      };
      mkdirSync(dirname(configPath), { recursive: true });
      // A same-directory transaction file keeps the rename on the same filesystem.
      const transactionPath = `${configPath}.${randomUUID()}.tmp`;
      try {
        writeFileSync(transactionPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
        renameSync(transactionPath, configPath);
      } finally {
        rmSync(transactionPath, { force: true });
      }
      return scopes;
    },
  };
}
