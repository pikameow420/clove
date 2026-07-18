export type IntimacySnapshot = {
  intimacyLevel: number;
  intimacyScore: number;
  intimacyProgress: number;
  leveledUp: boolean;
};

export function serializeIntimacy(params: {
  intimacyLevel?: number | null;
  intimacyScore?: number | null;
  leveledUp?: boolean;
}): IntimacySnapshot {
  const intimacyLevel = params.intimacyLevel ?? 1;
  const intimacyScore = params.intimacyScore ?? 0;
  return {
    intimacyLevel,
    intimacyScore,
    intimacyProgress: intimacyScore / 100,
    leveledUp: params.leveledUp ?? false,
  };
}
