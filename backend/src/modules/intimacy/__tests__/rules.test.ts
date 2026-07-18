import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DAILY_TOTAL_CAP,
  applyScoreDelta,
  applyUsageDelta,
  clampGrantedPoints,
  classifyUserMessage,
  emptyDailyUsage,
  memoryWarmthPoints,
  startOfUtcDay,
  utcDayKey,
} from "../rules";
import { serializeIntimacy } from "../serializer";
import { getIntimacyToneInstruction } from "../prompt";

describe("classifyUserMessage", () => {
  it("marks filler phrases and emoji-only as filler", () => {
    assert.equal(classifyUserMessage("lol"), "filler");
    assert.equal(classifyUserMessage("k"), "filler");
    assert.equal(classifyUserMessage("hey"), "filler");
    assert.equal(classifyUserMessage("a"), "filler");
    assert.equal(classifyUserMessage("😂😂"), "filler");
  });

  it("marks meaningful messages by words, question, or length", () => {
    assert.equal(classifyUserMessage("how was your day?"), "meaningful");
    assert.equal(
      classifyUserMessage("one two three four five six seven eight"),
      "meaningful"
    );
    assert.equal(classifyUserMessage("x".repeat(40)), "meaningful");
  });

  it("marks short non-filler messages as regular", () => {
    assert.equal(classifyUserMessage("coffee later"), "regular");
  });
});

describe("clampGrantedPoints and daily caps", () => {
  it("applies total and chat caps with partial credit", () => {
    const usage = emptyDailyUsage();
    usage.totalGranted = DAILY_TOTAL_CAP - 2;
    usage.chatGranted = 99;
    assert.equal(clampGrantedPoints("user_message_meaningful", 5, usage), 1);
  });

  it("blocks count-capped events at their limits", () => {
    const usage = emptyDailyUsage();
    usage.answeredQuestionCount = 4;
    assert.equal(clampGrantedPoints("answered_question", 8, usage), 0);

    usage.photoMomentCount = 3;
    assert.equal(clampGrantedPoints("photo_moment_cache", 12, usage), 0);
  });
});

describe("applyScoreDelta", () => {
  it("levels up and resets score to 10", () => {
    const next = applyScoreDelta({ intimacyLevel: 2, intimacyScore: 97, leveledUp: false }, 5);
    assert.deepEqual(next, { intimacyLevel: 3, intimacyScore: 10, leveledUp: true });
  });

  it("caps at level 5 score 100", () => {
    const next = applyScoreDelta({ intimacyLevel: 5, intimacyScore: 98, leveledUp: false }, 10);
    assert.deepEqual(next, { intimacyLevel: 5, intimacyScore: 100, leveledUp: false });
  });

  it("allows only one level-up per event", () => {
    const next = applyScoreDelta({ intimacyLevel: 1, intimacyScore: 99, leveledUp: false }, 200);
    assert.equal(next.intimacyLevel, 2);
    assert.equal(next.intimacyScore, 10);
    assert.equal(next.leveledUp, true);
  });
});

describe("applyUsageDelta", () => {
  it("tracks chat and count buckets", () => {
    let usage = emptyDailyUsage();
    usage = applyUsageDelta(usage, "user_message_meaningful", 5);
    usage = applyUsageDelta(usage, "answered_question", 8);
    usage = applyUsageDelta(usage, "photo_moment_generated", 16);
    assert.equal(usage.totalGranted, 29);
    assert.equal(usage.chatGranted, 5);
    assert.equal(usage.answeredQuestionCount, 1);
    assert.equal(usage.photoMomentCount, 1);
  });
});

describe("memoryWarmthPoints", () => {
  it("sums and clamps per field and per refresh", () => {
    assert.equal(memoryWarmthPoints(3, 3, 3), 9);
    assert.equal(memoryWarmthPoints(10, -1, 2), 5);
  });
});

describe("utc helpers", () => {
  it("computes UTC day boundaries", () => {
    const date = new Date("2026-07-18T23:30:00.000Z");
    assert.equal(utcDayKey(date), "2026-07-18");
    assert.equal(startOfUtcDay(date).toISOString(), "2026-07-18T00:00:00.000Z");
  });
});

describe("serializeIntimacy", () => {
  it("defaults and computes progress", () => {
    assert.deepEqual(serializeIntimacy({}), {
      intimacyLevel: 1,
      intimacyScore: 0,
      intimacyProgress: 0,
      leveledUp: false,
    });
    assert.equal(serializeIntimacy({ intimacyLevel: 3, intimacyScore: 50 }).intimacyProgress, 0.5);
  });
});

describe("getIntimacyToneInstruction", () => {
  it("returns level-specific guidance without narrating the meter", () => {
    for (const level of [1, 2, 3, 4, 5]) {
      const text = getIntimacyToneInstruction(level);
      assert.match(text, new RegExp(`level ${level}`));
      assert.match(text, /Never mention points/);
    }
  });
});
