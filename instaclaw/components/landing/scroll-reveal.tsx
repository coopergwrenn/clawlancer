"use client";

import { useEffect, useRef, useState } from "react";

// Decoration types: *highlight*, ~circle~, _underline_
function parseDecorations(text: string) {
  const words = text.split(" ");
  return words.map((word) => {
    let cleanWord = word;
    let decoration: "highlight" | "circle" | "underline" | null = null;

    if (word.startsWith("*") && word.endsWith("*")) {
      decoration = "highlight";
      cleanWord = word.slice(1, -1);
    } else if (word.startsWith("~") && word.endsWith("~")) {
      decoration = "circle";
      cleanWord = word.slice(1, -1);
    } else if (word.startsWith("_") && word.endsWith("_")) {
      decoration = "underline";
      cleanWord = word.slice(1, -1);
    }

    return { word: cleanWord, decoration };
  });
}

function Highlight({ children, revealed }: { children: string; revealed: boolean }) {
  const [everRevealed, setEverRevealed] = useState(false);

  useEffect(() => {
    if (revealed && !everRevealed) {
      setEverRevealed(true);
    }
  }, [revealed, everRevealed]);

  const isShown = revealed || everRevealed;

  return (
    <span className={`scroll-word${isShown ? " revealed" : ""} relative inline-block`}>
      <span
        className="absolute inset-0 -mx-1 -my-0.5 rounded transition-all duration-500"
        style={{
          background: "#fef08a",
          opacity: isShown ? 1 : 0,
          transform: isShown ? "scale(1)" : "scale(0.95)",
        }}
      />
      <span className="relative">{children}</span>
    </span>
  );
}

function Circle({ children, revealed }: { children: string; revealed: boolean }) {
  const [everRevealed, setEverRevealed] = useState(false);

  useEffect(() => {
    if (revealed && !everRevealed) {
      setEverRevealed(true);
    }
  }, [revealed, everRevealed]);

  const isShown = revealed || everRevealed;

  return (
    <span className={`scroll-word${isShown ? " revealed" : ""} relative inline-block`}>
      <svg
        className="absolute pointer-events-none"
        style={{
          left: "calc(-100% - 20px)",
          top: "-10px",
          width: "calc(200% + 32px)",
          height: "calc(100% + 20px)",
        }}
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 200 100"
        preserveAspectRatio="none"
      >
        {/* Wide ellipse covering "does things." */}
        <path
          d="M8,50 Q10,16 55,13 Q120,10 170,20 Q192,35 190,55 Q188,78 150,86 Q100,92 40,84 Q6,74 8,50"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            strokeDasharray: "600",
            strokeDashoffset: isShown ? 0 : 600,
            transition: "stroke-dashoffset 0.8s ease-out",
            opacity: isShown ? 0.5 : 0,
          }}
        />
        <path
          d="M9,51 Q11,18 56,15 Q122,12 171,22 Q191,36 189,56 Q187,77 149,85 Q99,91 41,83 Q7,73 9,51"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            strokeDasharray: "600",
            strokeDashoffset: isShown ? 0 : 600,
            transition: "stroke-dashoffset 0.9s ease-out",
            opacity: isShown ? 0.6 : 0,
          }}
        />
      </svg>
      <span className="relative">{children}</span>
    </span>
  );
}

function Underline({ children, revealed }: { children: string; revealed: boolean }) {
  const [everRevealed, setEverRevealed] = useState(false);

  useEffect(() => {
    if (revealed && !everRevealed) {
      setEverRevealed(true);
    }
  }, [revealed, everRevealed]);

  const isShown = revealed || everRevealed;

  return (
    <span className={`scroll-word${isShown ? " revealed" : ""} relative inline-block`}>
      <svg
        className="absolute pointer-events-none"
        style={{
          left: "-2px",
          bottom: "-2px",
          width: "calc(100% + 4px)",
          height: "8px",
        }}
        xmlns="http://www.w3.org/2000/svg"
        preserveAspectRatio="none"
      >
        <path
          d="M0,4 Q25,2 50,4 T100,4"
          vectorEffect="non-scaling-stroke"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          style={{
            strokeDasharray: "100",
            strokeDashoffset: isShown ? 0 : 100,
            transition: "stroke-dashoffset 0.8s ease-out",
            opacity: isShown ? 0.8 : 0,
          }}
        />
      </svg>
      <span className="relative">{children}</span>
    </span>
  );
}

export function ScrollReveal({ text }: { text: string }) {
  const sectionRef = useRef<HTMLElement>(null);
  const [revealedCount, setRevealedCount] = useState(0);
  const parsedWords = parseDecorations(text);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;

    let active = false;

    function onScroll() {
      if (!active || !section) return;
      const rect = section.getBoundingClientRect();
      const viewportH = window.innerHeight;
      const total = rect.height + viewportH;
      const scrolled = viewportH - rect.top;
      const progress = Math.min(Math.max(scrolled / total, 0), 1);
      const mapped = Math.min(Math.max((progress - 0.15) / 0.7, 0), 1);
      const newCount = Math.round(mapped * parsedWords.length);
      // Only increase, never decrease (words stay revealed once shown)
      setRevealedCount(prev => Math.max(prev, newCount));
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        active = entry.isIntersecting;
        if (active) onScroll();
      },
      { threshold: 0 }
    );

    observer.observe(section);
    window.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", onScroll);
    };
  }, [parsedWords.length]);

  return (
    <section ref={sectionRef} className="py-16 sm:py-[12vh] px-4">
      <div className="max-w-4xl mx-auto">
        <p
          className="text-3xl sm:text-4xl lg:text-5xl font-normal tracking-[-0.5px] leading-[1.25]"
          style={{ fontFamily: "var(--font-serif)" }}
        >
          {parsedWords.map(({ word, decoration }, i) => {
            const revealed = i < revealedCount;
            const wordSpan = (
              <span
                className={`scroll-word${revealed ? " revealed" : ""}`}
              >
                {word}
              </span>
            );

            return (
              <span key={i} className="scroll-word-wrapper">
                {decoration === "highlight" ? (
                  <Highlight revealed={revealed}>{word}</Highlight>
                ) : decoration === "circle" ? (
                  <Circle revealed={revealed}>{word}</Circle>
                ) : decoration === "underline" ? (
                  <Underline revealed={revealed}>{word}</Underline>
                ) : (
                  wordSpan
                )}{" "}
              </span>
            );
          })}
        </p>
      </div>
    </section>
  );
}
