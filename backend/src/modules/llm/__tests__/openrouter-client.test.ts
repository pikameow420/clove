import "dotenv/config";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildOpenRouterRequestBody,
  parseOpenRouterResponse,
  parseOpenRouterSseEvent
} from "../openrouter-client";
import type { LlmChatMessage } from "../types";

describe("buildOpenRouterRequestBody", () => {
  it("passes messages through with the configured model", () => {
    const body = buildOpenRouterRequestBody(
      "google/gemma-3-27b-it:free",
      [
        { role: "system", content: "You are Kaelen." },
        { role: "user", content: "hey" }
      ],
      false
    );

    assert.equal(body.model, "google/gemma-3-27b-it:free");
    assert.equal(body.stream, false);
    assert.deepEqual(body.messages, [
      { role: "system", content: "You are Kaelen." },
      { role: "user", content: "hey" }
    ]);
  });

  it("requests a JSON response format only for json responses", () => {
    const messages: LlmChatMessage[] = [{ role: "user", content: "classify this" }];

    assert.deepEqual(
      buildOpenRouterRequestBody("google/gemma-3-27b-it:free", messages, false, {
        responseFormat: "json"
      }).response_format,
      { type: "json_object" }
    );
    assert.equal(
      buildOpenRouterRequestBody("google/gemma-3-27b-it:free", messages, false).response_format,
      undefined
    );
  });

  it("passes temperature and token budget through", () => {
    const body = buildOpenRouterRequestBody(
      "google/gemma-3-27b-it:free",
      [{ role: "user", content: "hi" }],
      false,
      {
        temperature: 0.1,
        maxTokens: 400
      }
    );

    assert.equal(body.temperature, 0.1);
    assert.equal(body.max_tokens, 400);
  });

  it("uses sensible defaults when options are omitted", () => {
    const body = buildOpenRouterRequestBody(
      "google/gemma-3-27b-it:free",
      [{ role: "user", content: "hi" }],
      false
    );

    assert.equal(body.temperature, 0.8);
    assert.equal(body.max_tokens, 256);
  });
});

describe("parseOpenRouterResponse", () => {
  it("extracts the first choice's content and total tokens", () => {
    const result = parseOpenRouterResponse({
      choices: [{ message: { content: "hey there" }, finish_reason: "stop" }],
      usage: { total_tokens: 42 }
    });

    assert.deepEqual(result, { content: "hey there", tokenCount: 42 });
  });

  it("reports a null token count when usage is missing", () => {
    const result = parseOpenRouterResponse({
      choices: [{ message: { content: "hi" }, finish_reason: "stop" }]
    });

    assert.equal(result.tokenCount, null);
  });

  it("returns empty content when no choices are present", () => {
    const result = parseOpenRouterResponse({});

    assert.deepEqual(result, { content: "", tokenCount: null });
  });

  it("throws when the API returns an error payload", () => {
    assert.throws(
      () => parseOpenRouterResponse({ error: { message: "rate limited" } }),
      /OpenRouter error: rate limited/
    );
  });
});

describe("parseOpenRouterSseEvent", () => {
  it("parses the data payload of an event", () => {
    const chunk = parseOpenRouterSseEvent('data: {"choices":[{"delta":{"content":"hi"}}]}');

    assert.equal(chunk?.choices?.[0]?.delta?.content, "hi");
  });

  it("ignores comments, heartbeats, and the done sentinel", () => {
    assert.equal(parseOpenRouterSseEvent(": keep-alive"), null);
    assert.equal(parseOpenRouterSseEvent(""), null);
    assert.equal(parseOpenRouterSseEvent("data: [DONE]"), null);
  });

  it("surfaces stream error payloads", () => {
    const chunk = parseOpenRouterSseEvent('data: {"error":{"message":"boom"}}');

    assert.equal(chunk?.error?.message, "boom");
  });
});