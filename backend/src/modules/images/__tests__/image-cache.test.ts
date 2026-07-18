import "dotenv/config";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scoreTagSimilarity, selectCacheMatch } from "../image-cache";
import type { ImageBrief } from "../image-intent";

const brief: ImageBrief = {
  scene: "coffee shop selfie",
  setting: "coffee shop",
  wardrobe: "green sweater",
  pose: "smiling",
  mood: "relaxed",
  camera: "selfie",
  sceneKey: "coffee-shop-selfie",
  tags: ["coffee-shop-selfie", "coffee-shop", "selfie", "green-sweater", "relaxed"],
};

function candidate(overrides: Partial<Parameters<typeof selectCacheMatch>[1][number]> = {}) {
  return {
    id: "asset-1",
    sceneKey: "other-scene",
    tags: [] as string[],
    storagePath: "characters/c1/generated/asset-1.webp",
    mimeType: "image/webp",
    description: null,
    ...overrides,
  };
}

describe("selectCacheMatch", () => {
  it("returns exact sceneKey match first", () => {
    const exact = candidate({ id: "exact", sceneKey: "coffee-shop-selfie" });
    const other = candidate({ id: "other" });
    assert.equal(selectCacheMatch(brief, [other, exact])?.id, "exact");
  });

  it("matches on mandatory tags plus high similarity", () => {
    const match = candidate({
      id: "tag-match",
      tags: ["coffee-shop-selfie", "coffee-shop", "selfie", "green-sweater", "relaxed"],
    });
    assert.equal(selectCacheMatch(brief, [match])?.id, "tag-match");
  });

  it("rejects candidates missing mandatory scene/setting/camera tags", () => {
    const missingMandatory = candidate({
      id: "no-mandatory",
      // High overlap but missing the mandatory setting tag "coffee-shop".
      tags: ["selfie", "green-sweater", "relaxed", "coffee-shop-selfie"],
    });
    assert.equal(selectCacheMatch(brief, [missingMandatory]), null);
  });

  it("rejects weak similarity even with mandatory tags", () => {
    const weak = candidate({
      id: "weak",
      tags: ["coffee-shop", "selfie", "coffee-shop-selfie"],
    });
    // 3/5 brief tags matched = 0.6, below the 0.75 threshold.
    assert.equal(selectCacheMatch(brief, [weak]), null);
  });

  it("returns null with no candidates", () => {
    assert.equal(selectCacheMatch(brief, []), null);
  });
});

describe("scoreTagSimilarity", () => {
  it("computes the matched fraction of brief tags", () => {
    assert.equal(scoreTagSimilarity(["a", "b"], new Set(["a"])), 0.5);
    assert.equal(scoreTagSimilarity(["a", "b"], new Set(["a", "b", "c"])), 1);
  });

  it("returns 0 for empty inputs", () => {
    assert.equal(scoreTagSimilarity([], new Set(["a"])), 0);
    assert.equal(scoreTagSimilarity(["a"], new Set()), 0);
  });
});
