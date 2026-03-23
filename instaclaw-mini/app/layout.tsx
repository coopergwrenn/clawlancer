import type { Metadata, Viewport } from "next";
import MiniKitSetup from "@/components/minikit-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "InstaClaw",
  description: "Your AI agent, powered by World",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <MiniKitSetup>
          {children}
        </MiniKitSetup>
      </body>
    </html>
  );
}
