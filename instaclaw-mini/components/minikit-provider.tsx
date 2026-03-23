"use client";

import { MiniKit } from "@worldcoin/minikit-js";
import { ReactNode, useEffect, useState, createContext, useContext } from "react";

const MiniKitContext = createContext({ ready: false });

export function useMiniKit() {
  return useContext(MiniKitContext);
}

export default function MiniKitSetup({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      MiniKit.install(process.env.NEXT_PUBLIC_APP_ID);
    } catch (e) {
      console.error("MiniKit install error:", e);
    }
    // Mark ready regardless — install is synchronous in practice,
    // and isInstalled() works immediately after install()
    setReady(true);
  }, []);

  return (
    <MiniKitContext.Provider value={{ ready }}>
      {children}
    </MiniKitContext.Provider>
  );
}
