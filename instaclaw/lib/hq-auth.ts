import { cookies } from "next/headers";

const COOKIE_NAME = "hq_session";

export async function verifyHQAuth(): Promise<boolean> {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  if (!token || !process.env.HQ_PASSWORD) return false;
  return token === process.env.HQ_PASSWORD;
}
