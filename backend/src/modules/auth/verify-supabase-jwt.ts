import { createRemoteJWKSet, jwtVerify } from "jose";
import { env } from "../../lib/env";

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks(): ReturnType<typeof createRemoteJWKSet> {
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`));
  }
  return jwks;
}

export async function verifySupabaseAccessToken(token: string): Promise<string> {
  const { payload } = await jwtVerify(token, getJwks(), {
    issuer: `${env.SUPABASE_URL}/auth/v1`,
  });

  if (!payload.sub || typeof payload.sub !== "string") {
    throw new Error("Invalid token: missing sub claim");
  }

  return payload.sub;
}

export function extractBearerToken(authorization: string | undefined): string | null {
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }

  const token = authorization.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}
