import React from "react";
import {
  AbsoluteFill,
  spring,
  useCurrentFrame,
  useVideoConfig,
  Sequence,
  interpolate,
} from "remotion";

interface VideoProps {
  brandName: string;
  tagline: string;
  primaryColor: string;
  bgDark: string;
  bgLight: string;
  textLight: string;
  headingFont: string;
  bodyFont: string;
  ctaText: string;
  ctaUrl: string;
}

/**
 * 4-Scene Marketing Video Template
 *
 * Scene 1 (0-3s):   Hook — Bold statement + brand name
 * Scene 2 (3-6s):   Problem — What the user struggles with
 * Scene 3 (6-12s):  Solution — Product demo / key features
 * Scene 4 (12-15s): CTA — Call to action
 *
 * Customize:
 * 1. Replace props with brand assets (fonts, colors, logo URL)
 * 2. Update copy in each scene
 * 3. Add product screenshots via staticFile()
 * 4. Render: npx remotion render src/index.ts MyVideo out/video.mp4
 */
export const MyVideo: React.FC<VideoProps> = ({
  brandName,
  tagline,
  primaryColor,
  bgDark,
  bgLight,
  textLight,
  headingFont,
  bodyFont,
  ctaText,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill style={{ backgroundColor: bgDark }}>
      {/* ── Scene 1: Hook (frames 0-90, 0-3s) ── */}
      <Sequence from={0} durationInFrames={90}>
        <AbsoluteFill
          style={{
            justifyContent: "center",
            alignItems: "center",
            backgroundColor: bgDark,
          }}
        >
          <HookScene
            brandName={brandName}
            tagline={tagline}
            primaryColor={primaryColor}
            textLight={textLight}
            headingFont={headingFont}
            bodyFont={bodyFont}
          />
        </AbsoluteFill>
      </Sequence>

      {/* ── Scene 2: Problem (frames 90-180, 3-6s) ── */}
      <Sequence from={90} durationInFrames={90}>
        <AbsoluteFill
          style={{
            justifyContent: "center",
            alignItems: "center",
            backgroundColor: bgLight,
          }}
        >
          <ProblemScene
            headingFont={headingFont}
            bodyFont={bodyFont}
            primaryColor={primaryColor}
          />
        </AbsoluteFill>
      </Sequence>

      {/* ── Scene 3: Solution (frames 180-360, 6-12s) ── */}
      <Sequence from={180} durationInFrames={180}>
        <AbsoluteFill
          style={{
            justifyContent: "center",
            alignItems: "center",
            backgroundColor: bgDark,
          }}
        >
          <SolutionScene
            textLight={textLight}
            primaryColor={primaryColor}
            headingFont={headingFont}
            bodyFont={bodyFont}
          />
        </AbsoluteFill>
      </Sequence>

      {/* ── Scene 4: CTA (frames 360-450, 12-15s) ── */}
      <Sequence from={360} durationInFrames={90}>
        <AbsoluteFill
          style={{
            justifyContent: "center",
            alignItems: "center",
            backgroundColor: primaryColor,
          }}
        >
          <CTAScene
            ctaText={ctaText}
            brandName={brandName}
            headingFont={headingFont}
            bodyFont={bodyFont}
            textLight={textLight}
          />
        </AbsoluteFill>
      </Sequence>
    </AbsoluteFill>
  );
};

/* ── Scene Components ── */

const HookScene: React.FC<{
  brandName: string;
  tagline: string;
  primaryColor: string;
  textLight: string;
  headingFont: string;
  bodyFont: string;
}> = ({ brandName, tagline, primaryColor, textLight, headingFont, bodyFont }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleScale = spring({ frame, fps, config: { damping: 12, stiffness: 100 } });
  const taglineOpacity = spring({
    frame: frame - 15,
    fps,
    config: { damping: 20 },
  });

  return (
    <div style={{ textAlign: "center" }}>
      <div
        style={{
          fontSize: 80,
          fontFamily: headingFont,
          color: textLight,
          fontWeight: 700,
          transform: `scale(${titleScale})`,
          marginBottom: 20,
        }}
      >
        {brandName}
      </div>
      <div
        style={{
          fontSize: 36,
          fontFamily: bodyFont,
          color: primaryColor,
          opacity: taglineOpacity,
        }}
      >
        {tagline}
      </div>
    </div>
  );
};

const ProblemScene: React.FC<{
  headingFont: string;
  bodyFont: string;
  primaryColor: string;
}> = ({ headingFont, bodyFont, primaryColor }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const problems = [
    "Spending hours on repetitive tasks",
    "Missing opportunities while you sleep",
    "Managing everything manually",
  ];

  return (
    <div style={{ textAlign: "center", padding: 60 }}>
      <div
        style={{
          fontSize: 48,
          fontFamily: headingFont,
          color: "#1a1a1a",
          fontWeight: 700,
          marginBottom: 40,
          opacity: spring({ frame, fps, config: { damping: 15 } }),
        }}
      >
        Sound familiar?
      </div>
      {problems.map((problem, i) => {
        const delay = 15 + i * 12;
        const opacity = spring({
          frame: frame - delay,
          fps,
          config: { damping: 20 },
        });
        const translateX = interpolate(opacity, [0, 1], [50, 0]);

        return (
          <div
            key={i}
            style={{
              fontSize: 28,
              fontFamily: bodyFont,
              color: "#333",
              opacity,
              transform: `translateX(${translateX}px)`,
              marginBottom: 16,
            }}
          >
            <span style={{ color: primaryColor, marginRight: 12 }}>✗</span>
            {problem}
          </div>
        );
      })}
    </div>
  );
};

const SolutionScene: React.FC<{
  textLight: string;
  primaryColor: string;
  headingFont: string;
  bodyFont: string;
}> = ({ textLight, primaryColor, headingFont, bodyFont }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const features = [
    { icon: "⚡", text: "Works 24/7 while you sleep" },
    { icon: "🎯", text: "Handles the tedious 80% automatically" },
    { icon: "📊", text: "Reports results every morning" },
  ];

  return (
    <div style={{ textAlign: "center", padding: 60 }}>
      <div
        style={{
          fontSize: 56,
          fontFamily: headingFont,
          color: textLight,
          fontWeight: 700,
          marginBottom: 50,
          opacity: spring({ frame, fps }),
        }}
      >
        There's a better way
      </div>
      {features.map((feat, i) => {
        const delay = 30 + i * 20;
        const scale = spring({
          frame: frame - delay,
          fps,
          config: { damping: 12, stiffness: 80 },
        });

        return (
          <div
            key={i}
            style={{
              fontSize: 32,
              fontFamily: bodyFont,
              color: textLight,
              transform: `scale(${scale})`,
              marginBottom: 24,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 16,
            }}
          >
            <span style={{ fontSize: 40 }}>{feat.icon}</span>
            <span>{feat.text}</span>
          </div>
        );
      })}
    </div>
  );
};

const CTAScene: React.FC<{
  ctaText: string;
  brandName: string;
  headingFont: string;
  bodyFont: string;
  textLight: string;
}> = ({ ctaText, brandName, headingFont, bodyFont, textLight }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const scale = spring({
    frame,
    fps,
    config: { damping: 10, stiffness: 80 },
  });

  const buttonOpacity = spring({
    frame: frame - 20,
    fps,
    config: { damping: 15 },
  });

  return (
    <div style={{ textAlign: "center" }}>
      <div
        style={{
          fontSize: 64,
          fontFamily: headingFont,
          color: textLight,
          fontWeight: 700,
          transform: `scale(${scale})`,
          marginBottom: 30,
        }}
      >
        Try {brandName}
      </div>
      <div
        style={{
          fontSize: 28,
          fontFamily: bodyFont,
          color: textLight,
          opacity: buttonOpacity,
          backgroundColor: "rgba(255,255,255,0.2)",
          padding: "16px 48px",
          borderRadius: 12,
          display: "inline-block",
          border: "2px solid rgba(255,255,255,0.4)",
        }}
      >
        {ctaText} →
      </div>
    </div>
  );
};
