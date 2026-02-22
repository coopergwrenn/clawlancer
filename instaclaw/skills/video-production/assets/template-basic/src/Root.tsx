import React from "react";
import { Composition } from "remotion";
import { MyVideo } from "./MyVideo";

export const Root: React.FC = () => {
  return (
    <>
      {/* Marketing Demo — 15 seconds @ 30fps */}
      <Composition
        id="MyVideo"
        component={MyVideo}
        durationInFrames={450}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{
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
        }}
      />
    </>
  );
};
