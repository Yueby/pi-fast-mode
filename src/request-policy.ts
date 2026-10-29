function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function usesExplicitDefault(api: string | undefined): boolean {
  return api === "openai-responses" || api === "openai-completions";
}

/** Returns a replacement payload only when the hook needs to change it. */
export function applyTierPolicy(payload: unknown, api: string | undefined, enabled: boolean): unknown {
  if (!isRecord(payload)) return;
  if (enabled) return { ...payload, service_tier: "priority" };

  // OpenAI's auto/omitted tier can follow backend defaults. Explicit default asks for standard processing.
  if (usesExplicitDefault(api)) return { ...payload, service_tier: "default" };

  // Codex and other protocols may reject "default". Remove only recognized fast tiers instead.
  if (payload.service_tier === "priority" || payload.service_tier === "fast" || payload.service_tier === "ultrafast") {
    const { service_tier: _tier, ...rest } = payload;
    return rest;
  }
}
