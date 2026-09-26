"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, ArrowUp, Sparkles } from "lucide-react";
import "./landing.css";

const PREVIEW_QUESTIONS = [
  "Where are the best fishing zones today?",
  "What's the weather near my location?",
  "Show me the marine map",
  "Give me a quick ocean overview",
];

export default function LandingPage() {
  const router = useRouter();
  const touchStart = useRef<number | null>(null);
  const [proximity, setProximity] = useState(0);
  const [pointer, setPointer] = useState({ x: 0, y: 0 });

  const enterApp = () => router.push("/app");

  useEffect(() => {
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY > 35) enterApp();
    };
    window.addEventListener("wheel", onWheel, { passive: true });
    return () => window.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onTouchStart = (event: React.TouchEvent) => {
    touchStart.current = event.touches[0].clientY;
  };

  const onTouchEnd = (event: React.TouchEvent) => {
    if (touchStart.current == null) return;
    const delta = touchStart.current - event.changedTouches[0].clientY;
    if (delta > 60) enterApp();
    touchStart.current = null;
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
    const y = ((event.clientY - rect.top) / rect.height - 0.5) * 2;
    setPointer({ x, y });

    const monkX = rect.left + rect.width * 0.5;
    const monkY = rect.top + rect.height * 0.43;
    const dx = event.clientX - monkX;
    const dy = event.clientY - monkY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const radius = Math.min(rect.width, rect.height) * 0.34;
    setProximity(Math.max(0, Math.min(1, 1 - distance / radius)));
  };

  const resetPointer = () => {
    setPointer({ x: 0, y: 0 });
    setProximity(0);
  };

  const sceneStyle = {
    "--mx": `${pointer.x * 5}px`,
    "--my": `${pointer.y * 3}px`,
    "--proximity": proximity.toFixed(3),
  } as React.CSSProperties;

  return (
    <div
      className="landing-page"
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      onPointerMove={onPointerMove}
      onPointerLeave={resetPointer}
    >
      <main className="hero" style={sceneStyle}>
        <div className="hero-bg" aria-hidden="true" />
        <div className="hero-atmosphere" aria-hidden="true" />

        <div className="meditation-ring ring-one" aria-hidden="true" />
        <div className="meditation-ring ring-two" aria-hidden="true" />
        <div className="meditation-ring ring-three" aria-hidden="true" />
        <div className="monk-focus" aria-hidden="true" />

        <div className="fabric-stream fabric-left" aria-hidden="true" />
        <div className="fabric-stream fabric-right" aria-hidden="true" />
        <div className="fabric-stream fabric-lower" aria-hidden="true" />

        <div className="wave-surge wave-surge-left" aria-hidden="true" />
        <div className="wave-surge wave-surge-right" aria-hidden="true" />
        <div className="wave-shimmer" aria-hidden="true" />

        <div className="hero-vignette" aria-hidden="true" />

        <section className="hero-copy">
          <p className="eyebrow">MARINE INTELLIGENCE. SAFER OCEANS.</p>
          <h1>
            ORC<span>A</span>
          </h1>
          <p className="hero-description">
            AI-powered marine intelligence that connects ocean data, weather,
            satellite observations and geospatial information to help people
            make smarter marine decisions.
          </p>
          <button className="primary-cta" onClick={enterApp}>
            <span>
              <ArrowRight size={20} />
            </span>
            Explore ORCA
          </button>
        </section>

        <aside className="hero-assistant-preview" aria-label="ORCA Assistant preview">
          <div className="preview-head">
            <div className="preview-avatar">◒</div>
            <div>
              <b>ORCA Assistant</b>
              <span>
                <i /> Online
              </span>
            </div>
            <Sparkles size={16} />
          </div>
          <div className="preview-message">
            Hi! I&apos;m ORCA — your marine intelligence assistant. Ask me
            anything about fishing zones, weather, ocean conditions, or
            explore the map.
          </div>
          {PREVIEW_QUESTIONS.map((question) => (
            <button key={question} onClick={enterApp}>
              {question}
              <ArrowRight size={15} />
            </button>
          ))}
          <div className="preview-input">
            Ask a question... <span>↑</span>
          </div>
        </aside>

        <button className="swipe-hint" onClick={enterApp}>
          <ArrowUp size={16} />
          <span>Swipe up to enter ORCA</span>
        </button>
      </main>
    </div>
  );
}
