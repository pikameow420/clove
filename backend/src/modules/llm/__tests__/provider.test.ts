import "dotenv/config";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { env } from "../../../lib/env";
import { activeProvider, extractJsonObject } from "../provider";

describe("activeProvider", () => {
  it("exposes the LLM_PROVIDER flag so call sites can log which backend is live", () => {
    assert.equal(activeProvider(), env.LLM_PROVIDER);
    assert.ok(
      activeProvider() === "ollama" ||
        activeProvider() === "gemini" ||
        activeProvider() === "openrouter"
    );
  });
});

describe("extractJsonObject", () => {
  it("pulls a bare object out of surrounding prose", () => {
    assert.deepEqual(extractJsonObject('noise {"ok":true} trailing'), { ok: true });
  });

  it("throws when the model forgot to emit JSON", () => {
    assert.throws(() => extractJsonObject("no braces here"), /No JSON object/);
  });
});
