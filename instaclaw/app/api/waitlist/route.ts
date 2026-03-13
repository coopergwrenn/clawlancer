import { NextResponse } from "next/server";

/**
 * Waitlist endpoint — deprecated.
 * Signups are now open without an invite code.
 * Kept as 410 Gone so old clients get a clear signal.
 */
export async function POST() {
  return NextResponse.json(
    { success: false, message: "Waitlist is closed — sign up directly at /signup" },
    { status: 410 }
  );
}
