import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET || "");
const PROXY_SECRET = new TextEncoder().encode(
  process.env.MINI_APP_PROXY_SECRET || ""
);

export interface SessionPayload {
  userId: string;
  walletAddress: string;
}

// --- Session management ---

export async function createSession(payload: SessionPayload): Promise<string> {
  const token = await new SignJWT(payload as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(JWT_SECRET);
  return token;
}

export async function getSession(): Promise<SessionPayload | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get("session")?.value;
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    return payload as unknown as SessionPayload;
  } catch {
    return null;
  }
}

export async function requireSession(): Promise<SessionPayload> {
  const session = await getSession();
  if (!session) throw new Error("Unauthorized");
  return session;
}

// --- Per-user proxy tokens for instaclaw.io writes ---

export async function signProxyToken(userId: string): Promise<string> {
  return new SignJWT({ userId, source: "mini-app" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("60s")
    .sign(PROXY_SECRET);
}

export async function verifyProxyToken(
  token: string
): Promise<{ userId: string } | null> {
  try {
    const { payload } = await jwtVerify(token, PROXY_SECRET);
    if (payload.source !== "mini-app") return null;
    return { userId: payload.userId as string };
  } catch {
    return null;
  }
}
