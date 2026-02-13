"use client";

import { Suspense, useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { SessionProvider } from "next-auth/react";
import posthog from "posthog-js";

if (typeof window !== "undefined" && process.env.NEXT_PUBLIC_POSTHOG_KEY) {
  posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY.trim(), {
    api_host: (process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com").trim(),
    capture_pageview: false, // we capture manually on route change
  });
}

function PostHogPageview() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (pathname) {
      let url = window.origin + pathname;
      if (searchParams?.toString()) url += "?" + searchParams.toString();
      posthog.capture("$pageview", { $current_url: url });
    }
  }, [pathname, searchParams]);

  return null;
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <Suspense fallback={null}>
        <PostHogPageview />
      </Suspense>
      {children}
    </SessionProvider>
  );
}
