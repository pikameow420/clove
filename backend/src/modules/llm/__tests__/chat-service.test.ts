import "dotenv/config";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { roleplaySegmentsForReply } from "../chat-service";

describe("roleplaySegmentsForReply", () => {
  it("returns null for plain dialogue so the client uses the simple bubble path", () => {
    assert.equal(roleplaySegmentsForReply("hey, what are you up to"), null);
  });

  it("returns null for empty or whitespace-only replies", () => {
    assert.equal(roleplaySegmentsForReply(""), null);
    assert.equal(roleplaySegmentsForReply("   "), null);
  });

  it("stores narration and dialogue when the model used asterisk scene markers", () => {
    const segments = roleplaySegmentsForReply(
      "*She leans against the doorframe, arms crossed.* Took you long enough."
    );

    assert.deepEqual(segments, [
      { type: "narration", text: "She leans against the doorframe, arms crossed." },
      { type: "dialogue", text: "Took you long enough." }
    ]);
  });

  it("stores a narration-only turn so pure scene setting still renders", () => {
    const segments = roleplaySegmentsForReply(
      "*The candlelight flickers across the shelves as she finally looks up.*"
    );

    assert.deepEqual(segments, [
      {
        type: "narration",
        text: "The candlelight flickers across the shelves as she finally looks up."
      }
    ]);
  });

  it("does not treat a single asterisked emphasis word as a scene beat", () => {
    assert.equal(roleplaySegmentsForReply("I *really* meant that"), null);
  });
});
