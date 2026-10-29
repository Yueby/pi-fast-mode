import assert from "node:assert/strict";
import test from "node:test";
import { applyTierPolicy } from "../src/request-policy.ts";

test("enabled mode injects priority without mutating input", () => {
  const payload = Object.freeze({ model: "alias", service_tier: "default", stream: true });
  assert.deepEqual(applyTierPolicy(payload, "openai-responses", true), { ...payload, service_tier: "priority" });
  assert.equal(payload.service_tier, "default");
});

test("disabled OpenAI APIs explicitly override existing tiers with default", () => {
  for (const api of ["openai-responses", "openai-completions"]) {
    for (const tier of [undefined, "priority", "fast", "ultrafast", "auto", "flex", "default"]) {
      const payload = Object.freeze({ service_tier: tier, stream: true });
      assert.deepEqual(applyTierPolicy(payload, api, false), { service_tier: "default", stream: true });
      assert.equal(payload.service_tier, tier);
    }
  }
});

test("Codex and other APIs remove fast fields without sending default", () => {
  for (const api of ["openai-codex-responses", "anthropic-messages", "custom-api", undefined]) {
    for (const tier of ["priority", "fast", "ultrafast"]) {
      const payload = Object.freeze({ service_tier: tier, stream: true });
      assert.deepEqual(applyTierPolicy(payload, api, false), { stream: true });
      assert.equal(payload.service_tier, tier);
    }
    assert.equal(applyTierPolicy({ stream: true }, api, false), undefined);
  }
});

test("other protocols keep unrelated non-fast tier fields", () => {
  for (const tier of ["auto", "flex", "standard_only", "default"]) {
    assert.equal(applyTierPolicy({ service_tier: tier }, "custom-api", false), undefined);
  }
});

test("non-object payloads are never replaced", () => {
  for (const payload of [undefined, null, [], "body", 5, false, () => {}]) {
    for (const enabled of [true, false]) {
      assert.equal(applyTierPolicy(payload, "openai-responses", enabled), undefined);
    }
  }
});
