import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ageFromDateOfBirth, isAtLeast18, parseDateOfBirth } from "../age";

describe("parseDateOfBirth", () => {
  it("parses a valid calendar date as UTC midnight", () => {
    const date = parseDateOfBirth("2000-05-15");
    assert.ok(date);
    assert.equal(date.toISOString(), "2000-05-15T00:00:00.000Z");
  });

  it("rejects malformed strings and impossible dates", () => {
    assert.equal(parseDateOfBirth("2000/05/15"), null);
    assert.equal(parseDateOfBirth("2000-13-01"), null);
    assert.equal(parseDateOfBirth("2000-02-30"), null);
    assert.equal(parseDateOfBirth("not-a-date"), null);
  });
});

describe("ageFromDateOfBirth", () => {
  it("counts whole years completed", () => {
    const dob = parseDateOfBirth("2000-07-18")!;
    assert.equal(ageFromDateOfBirth(dob, new Date("2026-07-17T12:00:00.000Z")), 25);
    assert.equal(ageFromDateOfBirth(dob, new Date("2026-07-18T00:00:00.000Z")), 26);
  });
});

describe("isAtLeast18", () => {
  it("accepts 18+ and rejects under 18", () => {
    const asOf = new Date("2026-07-18T12:00:00.000Z");
    assert.equal(isAtLeast18(parseDateOfBirth("2008-07-18")!, asOf), true);
    assert.equal(isAtLeast18(parseDateOfBirth("2008-07-19")!, asOf), false);
  });
});
