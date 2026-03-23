"use client";

import { MiniKit } from "@worldcoin/minikit-js";
import { ReactNode, useEffect } from "react";

export default function MiniKitSetup({ children }: { children: ReactNode }) {
  useEffect(() => {
    MiniKit.install(process.env.NEXT_PUBLIC_APP_ID);
  }, []);

  return <>{children}</>;
}
