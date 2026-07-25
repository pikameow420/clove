import "dotenv/config";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseGeminiResponse,
  parseSseEvent,
  splitSseEvents,
  toGeminiRequestBody
} from "../gemini-client";
import { LlmBlockedError, type LlmChatMessage } from "../types";

describe("toGeminiRequestBody", () => {
  it("folds every system message into a single systemInstruction", () => {
    const body = toGeminiRequestBody([
      { role: "system", content: "You are Kaelen." },
      { role: "system", content: "Keep replies short." },
      { role: "user", content: "hey" }
    ]);

    assert.equal(body.systemInstruction?.parts[0]?.text, "You are Kaelen.\n\nKeep replies short.");
    assert.deepEqual(body.contents, [{ role: "user", parts: [{ text: "hey" }] }]);
  });

  it("maps assistant turns to the model role", () => {
    const body = toGeminiRequestBody([
      { role: "user", content: "hey" },
      { role: "assistant", content: "hey yourself" },
      { role: "user", content: "what are you up to" }
    ]);

    assert.deepEqual(
      body.contents.map((content) => content.role),
      ["user", "model", "user"]
    );
  });

  it("collapses consecutive turns from the same speaker", () => {
    const body = toGeminiRequestBody([
      { role: "user", content: "one" },
      { role: "user", content: "two" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "three" }
    ]);

    assert.equal(body.contents.length, 3);
    assert.deepEqual(body.contents[0]?.parts, [{ text: "one" }, { text: "two" }]);
  });

  it("appends a user turn when history would otherwise end on the model", () => {
    // Proactive outreach folds the synthetic user turn into a system message,
    // which leaves the last assistant reply trailing. Gemini rejects that.
    const body = toGeminiRequestBody([
      { role: "system", content: "Send a check-in." },
      { role: "user", content: "hey" },
      { role: "assistant", content: "hey" }
    ]);

    assert.equal(body.contents[body.contents.length - 1]?.role, "user");
  });

  it("still sends a user turn when there is no history at all", () => {
    const body = toGeminiRequestBody([{ role: "system", content: "Say hello." }]);

    assert.equal(body.contents.length, 1);
    assert.equal(body.contents[0]?.role, "user");
  });

  it("skips blank messages", () => {
    const body = toGeminiRequestBody([
      { role: "user", content: "hey" },
      { role: "assistant", content: "   " }
    ]);

    assert.deepEqual(body.contents, [{ role: "user", parts: [{ text: "hey" }] }]);
  });

  it("requests a JSON mime type only for json responses", () => {
    const messages: LlmChatMessage[] = [{ role: "user", content: "classify this" }];

    assert.equal(
      toGeminiRequestBody(messages, { responseFormat: "json" }).generationConfig.responseMimeType,
      "application/json"
    );
    assert.equal(toGeminiRequestBody(messages).generationConfig.responseMimeType, undefined);
  });

  it("passes temperature and token budget through", () => {
    const body = toGeminiRequestBody([{ role: "user", content: "hi" }], {
      temperature: 0.1,
      maxTokens: 400
    });

    assert.equal(body.generationConfig.temperature, 0.1);
    assert.equal(body.generationConfig.maxOutputTokens, 400);
  });

  it("disables category blocking so in-character romance is not filtered", () => {
    const body = toGeminiRequestBody([{ role: "user", content: "hi" }]);

    assert.ok(
      body.safetySettings.some(
        (setting) =>
          setting.category === "HARM_CATEGORY_SEXUALLY_EXPLICIT" &&
          setting.threshold === "BLOCK_NONE"
      )
    );
    assert.ok(body.safetySettings.every((setting) => setting.threshold === "BLOCK_NONE"));
  });
});

describe("parseGeminiResponse", () => {
  it("joins the text parts of the first candidate", () => {
    const result = parseGeminiResponse({
      candidates: [{ content: { parts: [{ text: "hey " }, { text: "there" }] }, finishReason: "STOP" }],
      usageMetadata: { totalTokenCount: 42 }
    });

    assert.deepEqual(result, { content: "hey there", tokenCount: 42 });
  });

  it("never leaks thought parts into the reply", () => {
    const result = parseGeminiResponse({
      candidates: [
        {
          content: { parts: [{ text: "planning my answer", thought: true }, { text: "hey" }] },
          finishReason: "STOP"
        }
      ]
    });

    assert.equal(result.content, "hey");
  });

  it("adds prompt and candidate tokens when no total is given", () => {
    const result = parseGeminiResponse({
      candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 }
    });

    assert.equal(result.tokenCount, 15);
  });

  it("reports a null token count when usage is missing", () => {
    const result = parseGeminiResponse({
      candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }]
    });

    assert.equal(result.tokenCount, null);
  });

  it("throws when the prompt itself was blocked", () => {
    assert.throws(
      () => parseGeminiResponse({ promptFeedback: { blockReason: "SAFETY" } }),
      (error: unknown) => error instanceof LlmBlockedError && error.reason === "SAFETY"
    );
  });

  it("throws when a candidate came back empty for a non-STOP reason", () => {
    assert.throws(
      () => parseGeminiResponse({ candidates: [{ content: { parts: [] }, finishReason: "SAFETY" }] }),
      LlmBlockedError
    );
  });

  it("keeps a truncated reply rather than failing on MAX_TOKENS", () => {
    const result = parseGeminiResponse({
      candidates: [{ content: { parts: [{ text: "this got cut o" }] }, finishReason: "MAX_TOKENS" }]
    });

    assert.equal(result.content, "this got cut o");
  });
});

describe("SSE parsing", () => {
  it("holds back the trailing partial event", () => {
    const { events, rest } = splitSseEvents('data: {"a":1}\n\ndata: {"b":2');

    assert.deepEqual(events, ['data: {"a":1}']);
    assert.equal(rest, 'data: {"b":2');
  });

  it("returns no events when nothing is complete yet", () => {
    const { events, rest } = splitSseEvents('data: {"a"');

    assert.deepEqual(events, []);
    assert.equal(rest, 'data: {"a"');
  });

  it("parses the data payload of an event", () => {
    const chunk = parseSseEvent('data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}');

    assert.equal(chunk?.candidates?.[0]?.content?.parts?.[0]?.text, "hi");
  });

  it("ignores comments, heartbeats, and the done sentinel", () => {
    assert.equal(parseSseEvent(": keep-alive"), null);
    assert.equal(parseSseEvent(""), null);
    assert.equal(parseSseEvent("data: [DONE]"), null);
  });
});
