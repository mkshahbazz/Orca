"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Loader2, Send, Ship } from "lucide-react";
import type { ChatMessage } from "@/app/page";

const QUICK_PROMPTS = [
  "Weather and waves near Chennai coast right now?",
  "Where is the best PFZ today?",
  "Can I fish at 16.0, 86.5?",
];

export default function ChatDrawer({
  messages,
  loading,
  onSend,
}: {
  messages: ChatMessage[];
  loading: boolean;
  onSend: (text: string) => void;
}) {
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  const submit = () => {
    const text = input.trim();
    if (!text || loading) return;
    onSend(text);
    setInput("");
  };

  return (
    <aside className="absolute inset-y-4 right-4 z-[1100] flex w-[92vw] max-w-[400px] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white/95 shadow-2xl backdrop-blur">
      {/* Header */}
      <header className="flex items-center gap-3 border-b border-slate-100 px-4 py-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-sky-600 text-white">
          <Ship size={18} />
        </div>
        <div>
          <h1 className="text-sm font-bold text-slate-800">Marine Assistant</h1>
          <p className="text-xs text-slate-500">Weather · PFZ · Hazard geofencing</p>
        </div>
      </header>

      {/* Quick prompts */}
      <div className="flex flex-wrap gap-1.5 border-b border-slate-100 px-3 py-2">
        {QUICK_PROMPTS.map((q) => (
          <button
            key={q}
            disabled={loading}
            onClick={() => onSend(q)}
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
                : "mr-auto rounded-bl-sm border border-slate-200 bg-slate-50 text-slate-800"
            }`}
          >
            {m.role === "assistant" ? (
              <div className="prose prose-sm max-w-none prose-headings:text-base prose-headings:font-semibold">
                <ReactMarkdown>{m.content}</ReactMarkdown>
              </div>
            ) : (
              m.content
            )}
          </div>
        ))}
        {loading && (
          <div className="mr-auto flex items-center gap-2 rounded-2xl rounded-bl-sm border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
            <Loader2 size={14} className="animate-spin" /> Consulting agents…
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
