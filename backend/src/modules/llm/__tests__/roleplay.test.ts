import "dotenv/config";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  hasNarration,
  parseRoleplaySegments,
  parseStoredSegments,
  previewTextFromContent,
  segmentsToPreviewText
} from "../roleplay";

describe("parseRoleplaySegments", () => {
  it("splits leading narration from the dialogue that follows", () => {
    const segments = parseRoleplaySegments(
      "*She leans against the doorframe, arms crossed.* Took you long enough."
    );

    assert.deepEqual(segments, [
      { type: "narration", text: "She leans against the doorframe, arms crossed." },
      { type: "dialogue", text: "Took you long enough." }
    ]);
  });

  it("splits trailing narration from the dialogue before it", () => {
    const segments = parseRoleplaySegments("Fine, you win. *she rolls her eyes*");

    assert.deepEqual(segments, [
      { type: "dialogue", text: "Fine, you win." },
      { type: "narration", text: "she rolls her eyes" }
    ]);
  });

  it("keeps narration in the middle of a turn in order", () => {
    const segments = parseRoleplaySegments("Wait. *she picks up the map* This is the one.");

    assert.deepEqual(segments, [
      { type: "dialogue", text: "Wait." },
      { type: "narration", text: "she picks up the map" },
      { type: "dialogue", text: "This is the one." }
    ]);
  });

  it("returns a single dialogue segment when there is no narration", () => {
    const segments = parseRoleplaySegments("just texting you back, nothing fancy");

    assert.deepEqual(segments, [
      { type: "dialogue", text: "just texting you back, nothing fancy" }
    ]);
    assert.equal(hasNarration(segments), false);
  });

  it("treats a single asterisked word as emphasis and keeps it inline", () => {
    const segments = parseRoleplaySegments("I *really* meant that");

    assert.deepEqual(segments, [{ type: "dialogue", text: "I really meant that" }]);
  });

  it("handles bold-style double asterisks as narration", () => {
    const segments = parseRoleplaySegments("**She smiles softly.** Hey you.");

    assert.deepEqual(segments, [
      { type: "narration", text: "She smiles softly." },
      { type: "dialogue", text: "Hey you." }
    ]);
  });

  it("merges adjacent narration beats into one block", () => {
    const segments = parseRoleplaySegments("*She walks in.* *The door shuts behind her.*");

    assert.deepEqual(segments, [
      { type: "narration", text: "She walks in. The door shuts behind her." }
    ]);
  });

  it("unwraps quoted dialogue, which models add out of habit", () => {
    const segments = parseRoleplaySegments('*She looks up.* "Did you find the map?"');

    assert.deepEqual(segments, [
      { type: "narration", text: "She looks up." },
      { type: "dialogue", text: "Did you find the map?" }
    ]);
  });

  it("leaves quotes alone when they wrap more than one quoted line", () => {
    const segments = parseRoleplaySegments('"Hi." she said. "Bye."');

    assert.deepEqual(segments, [{ type: "dialogue", text: '"Hi." she said. "Bye."' }]);
  });

  it("degrades to dialogue when an asterisk is left unclosed", () => {
    const segments = parseRoleplaySegments("*She smiles and then trails off");

    assert.deepEqual(segments, [{ type: "dialogue", text: "She smiles and then trails off" }]);
  });

  it("returns nothing for empty or whitespace-only output", () => {
    assert.deepEqual(parseRoleplaySegments(""), []);
    assert.deepEqual(parseRoleplaySegments("   \n  "), []);
  });

  it("preserves line breaks inside dialogue", () => {
    const segments = parseRoleplaySegments("first line\nsecond line");

    assert.deepEqual(segments, [{ type: "dialogue", text: "first line\nsecond line" }]);
  });

  it("keeps a long atmospheric scene beat as one narration block", () => {
    const scene =
      "The dimly lit library atmosphere is tense; dust motes dance in the flickering candlelight as they search the dusty shelves. Kaelen watches Luna intently.";
    const segments = parseRoleplaySegments(`*${scene}* Did you find the map?`);

    assert.deepEqual(segments, [
      { type: "narration", text: scene },
      { type: "dialogue", text: "Did you find the map?" }
    ]);
    assert.equal(hasNarration(segments), true);
  });
});

describe("segmentsToPreviewText", () => {
  it("uses dialogue only, so notifications never show scene markup", () => {
    const segments = parseRoleplaySegments("*She waves from across the room.* Over here!");

    assert.equal(segmentsToPreviewText(segments), "Over here!");
  });

  it("joins several dialogue segments", () => {
    const segments = parseRoleplaySegments("Wait. *she turns around* I forgot something.");

    assert.equal(segmentsToPreviewText(segments), "Wait. I forgot something.");
  });

  it("falls back to narration when the whole turn was scene setting", () => {
    const segments = parseRoleplaySegments("*She stares at the ceiling, saying nothing.*");

    assert.equal(segmentsToPreviewText(segments), "She stares at the ceiling, saying nothing.");
  });

  it("reads previews straight from stored content", () => {
    assert.equal(previewTextFromContent("*She waves.* Hey there."), "Hey there.");
    assert.equal(previewTextFromContent("no narration at all"), "no narration at all");
  });
});

describe("parseStoredSegments", () => {
  it("revives a well formed segment array", () => {
    const raw = [
      { type: "narration", text: "She sits down." },
      { type: "dialogue", text: "So, tell me." }
    ];

    assert.deepEqual(parseStoredSegments(raw), raw);
  });

  it("drops entries with an unknown type or empty text", () => {
    const raw = [
      { type: "narration", text: "She sits down." },
      { type: "sound_effect", text: "thud" },
      { type: "dialogue", text: "   " },
      null,
      "nope"
    ];

    assert.deepEqual(parseStoredSegments(raw), [{ type: "narration", text: "She sits down." }]);
  });

  it("returns null for non-arrays and for arrays with nothing usable", () => {
    assert.equal(parseStoredSegments(null), null);
    assert.equal(parseStoredSegments(undefined), null);
    assert.equal(parseStoredSegments("[]"), null);
    assert.equal(parseStoredSegments([]), null);
    assert.equal(parseStoredSegments([{ type: "bogus", text: "x" }]), null);
  });
});
