const DATE_OF_BIRTH_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Parses a calendar date `YYYY-MM-DD` into a UTC midnight Date.
 * Returns null for malformed or impossible calendar dates.
 */
export function parseDateOfBirth(value: string): Date | null {
  const match = DATE_OF_BIRTH_RE.exec(value);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return date;
}

/** Whole years completed as of `asOf` (UTC calendar). */
export function ageFromDateOfBirth(dateOfBirth: Date, asOf: Date = new Date()): number {
  let age = asOf.getUTCFullYear() - dateOfBirth.getUTCFullYear();
  const monthDelta = asOf.getUTCMonth() - dateOfBirth.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && asOf.getUTCDate() < dateOfBirth.getUTCDate())) {
    age -= 1;
  }
  return age;
}

export function isAtLeast18(dateOfBirth: Date, asOf: Date = new Date()): boolean {
  return ageFromDateOfBirth(dateOfBirth, asOf) >= 18;
}
