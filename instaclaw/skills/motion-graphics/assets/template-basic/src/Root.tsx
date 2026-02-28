import React from "react";
import { Composition } from "remotion";
import { MyVideo } from "./MyVideo";

export const Root: React.FC = () => {
  const defaultProps = {
    brandName: "Your Brand",
    tagline: "Your Tagline Here",
    primaryColor: "#e67e4d",
    bgDark: "#0f1419",
    bgLight: "#f5f3ee",
    textLight: "#ffffff",
    headingFont: '"Instrument Serif", serif',
    bodyFont: "Inter, sans-serif",
    ctaText: "Get Started",
    ctaUrl: "https://example.com",
  };

  return (
    <>
      {/* 16:9 landscape (YouTube, website) — 15s @ 30fps */}
      <Composition
        id="MyVideo"
        component={MyVideo}
        durationInFrames={450}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={defaultProps}
      />

      {/* 9:16 vertical (TikTok, Reels, Stories) — 15s @ 30fps */}
      <Composition
        id="Vertical"
        component={MyVideo}
        durationInFrames={450}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={defaultProps}
      />

      {/* 1:1 square (Instagram feed) — 15s @ 30fps */}
      <Composition
        id="Square"
        component={MyVideo}
        durationInFrames={450}
        fps={30}
        width={1080}
        height={1080}
        defaultProps={defaultProps}
      />
    </>
  );
};
