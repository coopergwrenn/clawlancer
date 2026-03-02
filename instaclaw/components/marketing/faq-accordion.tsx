"use client";

import { useState } from "react";

export interface FaqItem {
  question: string;
  answer: string;
}

export function FaqAccordion({ items }: { items: FaqItem[] }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  return (
    <div>
      {items.map((item, i) => (
        <div
          key={i}
          className="border-b"
          style={{ borderColor: "rgba(0,0,0,0.1)" }}
        >
          <button
            onClick={() => setOpenIndex(openIndex === i ? null : i)}
            className="w-full text-left px-0 py-5 flex items-center justify-between cursor-pointer"
            style={{ color: "#333334" }}
          >
            <span className="font-medium text-sm sm:text-base pr-4">{item.question}</span>
            <span
              className="shrink-0 text-xl leading-none select-none transition-transform duration-200"
              style={{
                color: "#6b6b6b",
                transform: openIndex === i ? "rotate(45deg)" : "rotate(0deg)",
              }}
            >
              +
            </span>
          </button>
          {openIndex === i && (
            <div className="pb-5">
              <p
                className="text-sm leading-relaxed"
                style={{ color: "#6b6b6b" }}
              >
                {item.answer}
              </p>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
