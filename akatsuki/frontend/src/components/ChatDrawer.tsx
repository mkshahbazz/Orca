"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Loader2, Send, Ship } from "lucide-react";
import type { ChatMessage, Confidence } from "@/app/app/page";

const QUICK_PROMPTS = [
  "Weather and waves near Chennai coast right now?",
  "Where is the best PFZ today?",
  "Can I fish at 16.0, 86.5?",
];

// Mirrors Bhashini's supported ISO-639 codes (backend: services/bhashini.py).
const LANGUAGES: Record<string, string> = {
  en: "EN",
  hi: "हिं",
  bn: "বাং",
  ta: "தமி",
  te: "తెలు",
  mr: "मरा",
  gu: "ગુ",
  kn: "ಕನ್",
  ml: "മല",
  pa: "ਪੰ",
  or: "ଓଡ",
  ur: "اردو",
};

const CONFIDENCE_STYLES: Record<
  string,
  { badge: string; dot: string; bar: string }
> = {
  high: {
    badge: "border-emerald-200 bg-emerald-50 text-emerald-700",
    dot: "bg-emerald-500",
    bar: "bg-emerald-500",
  },
  moderate: {
    badge: "border-amber-200 bg-amber-50 text-amber-700",
    dot: "bg-amber-500",
    bar: "bg-amber-500",
  },
  low: {
    badge: "border-rose-200 bg-rose-50 text-rose-700",
    dot: "bg-rose-500",
    bar: "bg-rose-500",
  },
};

/**
 * Color-coded confidence meter. The one-sentence justification lives inside a
 * tooltip that appears on hover so the answer text stays uncluttered.
 */
function ConfidenceMeter({ confidence }: { confidence: Confidence }) {
  const s = CONFIDENCE_STYLES[confidence.label] ?? CONFIDENCE_STYLES.moderate;
  const width = Math.max(4, Math.min(100, Math.round(confidence.score)));

  return (
    <div className="group relative mt-2 inline-flex flex-col gap-1">
      <div
        className={`inline-flex cursor-help items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${s.badge}`}
        tabIndex={0}
        aria-label={`Confidence ${confidence.score}% (${confidence.label}). ${confidence.justification}`}
        title={confidence.justification}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
        {confidence.score}% confidence · {confidence.label}
      </div>

      {/* visual meter */}
      <div className="h-1 w-full overflow-hidden rounded-full bg-slate-200">
        <div className={`h-full rounded-full ${s.bar}`} style={{ width: `${width}%` }} />
      </div>

      {/* hover tooltip with the justification */}
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-0 z-50 mb-2 w-64 rounded-lg border border-slate-200 bg-slate-900 px-2.5 py-2 text-[11px] font-normal leading-snug text-white opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {confidence.justification}
      </span>
    </div>
  );
}

export default function ChatDrawer({
  messages,
  loading,
  status,
  language = "en",
  onLanguageChange,
  onSend,
}: {
  messages: ChatMessage[];
  loading: boolean;
  /** live background step reported by the backend while it works */
  status?: string;
  language?: string;
  onLanguageChange?: (code: string) => void;
  onSend: (text: string, language?: string) => void;
}) {
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading, status]);

  const submit = () => {
    const text = input.trim();
    if (!text || loading) return;
    onSend(text, language);
    setInput("");
  };

  return (
    <aside className="absolute inset-y-4 right-4 z-[1100] flex w-[92vw] max-w-[400px] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white/95 shadow-2xl backdrop-blur">
      {/* Header */}
      <header className="flex items-center gap-3 border-b border-slate-100 px-4 py-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-sky-600 text-white">
          <Ship size={18} />
        </div>
        <div className="flex-1">
          <h1 className="text-sm font-bold text-slate-800">Marine Assistant</h1>
          <p className="text-xs text-slate-500">Weather · PFZ · Hazard geofencing</p>
        </div>
        <select
          value={language}
          onChange={(e) => onLanguageChange?.(e.target.value)}
          aria-label="Reply language"
          title="Answer language (Bhashini translation)"
          className="rounded-lg border border-slate-200 bg-white px-1.5 py-1 text-xs text-slate-600 outline-none focus:border-sky-400"
        >
          {Object.entries(LANGUAGES).map(([code, label]) => (
            <option key={code} value={code}>
              {label}
            </option>
          ))}
        </select>
      </header>

      {/* Quick prompts */}
      <div className="flex flex-wrap gap-1.5 border-b border-slate-100 px-3 py-2">
        {QUICK_PROMPTS.map((q) => (
          <button
            key={q}
            disabled={loading}
            onClick={() => onSend(q, language)}
            className="rounded-full border border-sky-200 bg-sky-50 px-2.5 py-1 text-[11px] text-sky-700 transition hover:bg-sky-100 disabled:opacity-50"
          >
            {q}
          </button>
        ))}
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {messages.length === 0 && (
          <p className="mt-6 text-center text-xs text-slate-400">
            Ask about weather, fishing zones, or whether a spot is safe to fish.
          </p>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={`max-w-[90%] rounded-2xl px-3 py-2 text-sm leading-relaxed ${
              m.role === "user"
                ? "ml-auto rounded-br-sm bg-sky-600 text-white"
                : m.error
                  ? "mr-auto rounded-bl-sm border border-rose-200 bg-rose-50 text-rose-800"
                  : "mr-auto rounded-bl-sm border border-slate-200 bg-slate-50 text-slate-800"
            }`}
          >
            {m.role === "assistant" ? (
              <>
                <div className="prose prose-sm max-w-none prose-headings:text-base prose-headings:font-semibold">
                  <ReactMarkdown>{m.content}</ReactMarkdown>
                </div>
                {m.confidence && <ConfidenceMeter confidence={m.confidence} />}
              </>
            ) : (
              m.content
            )}
          </div>
        ))}

        {/* Live status: shows the background step instead of a frozen spinner */}
        {loading && (
          <div className="mr-auto flex items-center gap-2 rounded-2xl rounded-bl-sm border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
            <Loader2 size={14} className="animate-spin" />
            <span className="transition-opacity duration-200">
              {status || "Consulting agents…"}
            </span>
          </div>
        )}
      </div>

      {/* Input */}
      <div className="flex items-center gap-2 border-t border-slate-100 p-3">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="Ask about the ocean…"
          className="flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-sky-400"
        />
        <button
          onClick={submit}
          disabled={loading || !input.trim()}
          className="flex h-9 w-9 items-center justify-center rounded-xl bg-sky-600 text-white transition hover:bg-sky-700 disabled:opacity-40"
          aria-label="Send"
        >
          <Send size={16} />
        </button>
      </div>
    </aside>
  );
}
