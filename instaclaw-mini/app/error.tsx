"use client";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex h-[100dvh] flex-col items-center justify-center gap-6 px-8 text-center">
      <div className="text-5xl">😵</div>
      <div>
        <h2 className="text-xl font-bold">Something went wrong</h2>
        <p className="mt-2 max-w-[280px] text-sm text-muted">
          {error.message || "An unexpected error occurred."}
        </p>
      </div>
      <button
        onClick={reset}
        className="btn-primary rounded-2xl px-8 py-3 font-semibold"
      >
        Try again
      </button>
    </div>
  );
}
