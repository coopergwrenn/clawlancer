"use client";

import { signIn } from "next-auth/react";
import Image from "next/image";
import Link from "next/link";

export default function SignInPage() {
  return (
    <div
      className="min-h-screen flex items-center justify-center px-4"
      style={{
        background: "#f8f7f4",
        color: "#333334",
      }}
    >
      <div className="w-full max-w-md space-y-10">
        {/* Logo */}
        <Link href="/" className="flex items-center justify-center gap-2">
          <Image src="/logo.png" alt="Instaclaw" width={40} height={40} unoptimized style={{ imageRendering: "pixelated" }} />
          <span
            className="text-2xl tracking-[-0.5px]"
            style={{ fontFamily: "var(--font-serif)", color: "#333334" }}
          >
            Instaclaw
          </span>
        </Link>

        {/* Heading */}
        <div className="text-center space-y-3">
          <h1
            className="text-4xl sm:text-5xl font-normal tracking-[-1px]"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            Welcome Back
          </h1>
          <p className="text-base" style={{ color: "#6b6b6b" }}>
            Sign in to your Instaclaw account.
          </p>
        </div>

        {/* Google sign-in */}
        <button
          onClick={() => signIn("google", { callbackUrl: "/dashboard" })}
          className="w-full px-6 py-4 rounded-lg text-base font-semibold transition-all cursor-pointer flex items-center justify-center gap-3"
          style={{
            background: "#ffffff",
            color: "#333334",
            border: "1px solid rgba(0, 0, 0, 0.1)",
          }}
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24">
            <path
              d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.10z"
              fill="#4285F4"
            />
            <path
              d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              fill="#34A853"
            />
            <path
              d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
              fill="#FBBC05"
            />
            <path
              d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
              fill="#EA4335"
            />
          </svg>
          Sign in with Google
        </button>

        {/* Link to signup */}
        <p className="text-sm text-center" style={{ color: "#6b6b6b" }}>
          Don&apos;t have an account?{" "}
          <Link
            href="/signup"
            className="underline transition-opacity hover:opacity-70"
            style={{ color: "#333334" }}
          >
            Sign up with an invite code
          </Link>
        </p>
      </div>
    </div>
  );
}
