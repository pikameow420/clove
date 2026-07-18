import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyScoreDelta,
  applyUsageDelta,
  clampGrantedPoints,
  emptyDailyUsage,
  type DailyUsage,
} from "../rules";

function simulateDay(events: Array<{ type: Parameters<typeof clampGrantedPoints>[0]; points: number }>) {
  let usage: DailyUsage = emptyDailyUsage();
  let state = { intimacyLevel: 1, intimacyScore: 0, leveledUp: false };
  let grantedTotal = 0;

  for (const event of events) {
    const granted = clampGrantedPoints(event.type, event.points, usage);
    usage = applyUsageDelta(usage, event.type, granted);
    state = applyScoreDelta(
      { intimacyLevel: state.intimacyLevel, intimacyScore: state.intimacyScore, leveledUp: false },
      granted
    );
    grantedTotal += granted;
  }

  return { state, grantedTotal, usage };
}

describe("two-day pacing simulation", () => {
  it("can reach level 5 across two engaged days under the rebalanced caps", () => {
    const day1 = simulateDay([
      ...Array.from({ length: 20 }, () => ({ type: "user_message_meaningful" as const, points: 5 })),
      ...Array.from({ length: 4 }, () => ({ type: "answered_question" as const, points: 8 })),
      { type: "shared_day", points: 10 },
      { type: "proactive_reply", points: 15 },
      { type: "proactive_reply", points: 15 },
      { type: "photo_request_accepted", points: 4 },
      { type: "photo_moment_cache", points: 12 },
      { type: "memory_warmth", points: 9 },
      { type: "memory_warmth", points: 9 },
      { type: "memory_warmth", points: 2 },
    ]);

    assert.ok(day1.grantedTotal <= 200);
    assert.ok(day1.grantedTotal >= 180);
    assert.ok(day1.state.intimacyLevel >= 2);

    // Continue day 2 from day-1 ending state with a fresh daily usage window.
    let state = day1.state;
    let usage = emptyDailyUsage();
    const day2Events = [
      ...Array.from({ length: 20 }, () => ({ type: "user_message_meaningful" as const, points: 5 })),
      ...Array.from({ length: 4 }, () => ({ type: "answered_question" as const, points: 8 })),
      { type: "shared_day" as const, points: 10 },
      { type: "proactive_reply" as const, points: 15 },
      { type: "proactive_reply" as const, points: 15 },
      { type: "photo_request_accepted" as const, points: 4 },
      { type: "photo_request_accepted" as const, points: 4 },
      { type: "photo_moment_generated" as const, points: 16 },
      { type: "photo_moment_cache" as const, points: 12 },
      { type: "photo_moment_cache" as const, points: 12 },
      { type: "memory_warmth" as const, points: 9 },
      { type: "memory_warmth" as const, points: 9 },
      { type: "memory_warmth" as const, points: 2 },
    ];

    for (const event of day2Events) {
      const granted = clampGrantedPoints(event.type, event.points, usage);
      usage = applyUsageDelta(usage, event.type, granted);
      state = applyScoreDelta(
        { intimacyLevel: state.intimacyLevel, intimacyScore: state.intimacyScore, leveledUp: false },
        granted
      );
    }

    assert.equal(state.intimacyLevel, 5);
  });

  it("grants nothing for filler-equivalent zero-point spam", () => {
    const result = simulateDay(Array.from({ length: 50 }, () => ({ type: "user_message" as const, points: 0 })));
    assert.equal(result.grantedTotal, 0);
    assert.equal(result.state.intimacyLevel, 1);
    assert.equal(result.state.intimacyScore, 0);
  });
});
