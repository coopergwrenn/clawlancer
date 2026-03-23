"use client";

import { MiniKit } from "@worldcoin/minikit-js";
import { ReactNode, useEffect } from "react";

export default function MiniKitSetup({ children }: { children: ReactNode }) {
  useEffect(() => {
    console.log("[InstaClaw] MiniKitSetup: installing MiniKit with appId:", process.env.NEXT_PUBLIC_APP_ID);
    try {
      MiniKit.install(process.env.NEXT_PUBLIC_APP_ID);
      console.log("[InstaClaw] MiniKit installed. isInstalled:", MiniKit.isInstalled());
    } catch (e) {
      console.error("[InstaClaw] MiniKit install error:", e);
    }
  }, []);

  return <>{children}</>;
}
