"use client";

import Image from "next/image";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

function AuthErrorContent() {
  const params = useSearchParams();
  const error = params.get("error");

  const isNoAccount = error === "NoAccount";
  const isAccessDenied = error === "AccessDenied";

  const title = isNoAccount
    ? "No account found"
    : isAccessDenied
      ? "Sign-up failed"
      : "Something went wrong";

  const description = isNoAccount
    ? "There\u2019s no Instaclaw account linked to that Google email. Make sure you\u2019re signing in with the same Google account you originally signed up with."
    : isAccessDenied
      ? "Your invite code could not be verified. This can happen if cookies were blocked or the code expired. Please try again."
      : "An unexpected error occurred during sign-in. Please try again.";

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4"
      style={{ background: "#f8f7f4", color: "#333334" }}
    >
      <div className="w-full max-w-md space-y-8 text-center">
        <Link href="/" className="flex items-center justify-center gap-2">
          <Image src="/logo.png" alt="Instaclaw" width={40} height={40} unoptimized style={{ imageRendering: "pixelated" }} />
          <span className="text-2xl tracking-[-0.5px]" style={{ fontFamily: "var(--font-serif)", color: "#333334" }}>
            Instaclaw
          </span>
        </Link>

        <div className="space-y-4">
          <h1
            className="text-3xl sm:text-4xl font-normal tracking-[-1px]"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            {title}
          </h1>

          <p className="text-base" style={{ color: "#6b6b6b" }}>
            {description}
          </p>
        </div>

        <div className="space-y-3">
          {isNoAccount ? (
            <Link
              href="/signin"
              className="block w-full px-6 py-4 rounded-lg text-base font-semibold transition-all"
              style={{
                background: "linear-gradient(-75deg, #c75a34, #DC6743, #e8845e, #DC6743, #c75a34)",
                color: "#ffffff",
                boxShadow: "rgba(255,255,255,0.2) 0px 2px 2px 0px inset, rgba(220,103,67,0.35) 0px 4px 16px 0px",
              }}
            >
              Try a different Google account
            </Link>
          ) : (
            <Link
              href="/signup"
              className="block w-full px-6 py-4 rounded-lg text-base font-semibold transition-all"
              style={{
                background: "linear-gradient(-75deg, #c75a34, #DC6743, #e8845e, #DC6743, #c75a34)",
                color: "#ffffff",
                boxShadow: "rgba(255,255,255,0.2) 0px 2px 2px 0px inset, rgba(220,103,67,0.35) 0px 4px 16px 0px",
              }}
            >
              Try again with your invite code
            </Link>
          )}

          <p className="text-sm" style={{ color: "#6b6b6b" }}>
            If this keeps happening, contact{" "}
            <a href="mailto:support@instaclaw.io" className="underline" style={{ color: "#333334" }}>
              support@instaclaw.io
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}

export default function AuthErrorPage() {
  return (
    <Suspense>
      <AuthErrorContent />
    </Suspense>
  );
}
