import { z } from "zod";

const nonEmptyString = z.string().trim().min(1);
const emptyCharacterProfile = {
  lifestyle: {},
  badges: [],
  prompts: []
};

export const characterProfileSchema = z
  .object({
    age: z.number().int().positive().max(120).optional(),
    height: nonEmptyString.optional(),
    job: nonEmptyString.optional(),
    education: nonEmptyString.optional(),
    location: nonEmptyString.optional(),
    relationshipIntent: nonEmptyString.optional(),
    lifestyle: z
      .object({
        drinking: nonEmptyString.optional(),
        smoking: nonEmptyString.optional(),
        exercise: nonEmptyString.optional(),
        kids: nonEmptyString.optional()
      })
      .default({}),
    zodiac: nonEmptyString.optional(),
    badges: z.array(nonEmptyString).default([]),
    prompts: z
      .array(
        z.object({
          question: nonEmptyString,
          answer: nonEmptyString
        })
      )
      .default([])
  })
  .default(emptyCharacterProfile);

export type CharacterProfile = z.infer<typeof characterProfileSchema>;
