"use client";

/**
 * THE SEAMONK — Ask the Monk.
 *
 * The console's conversational window. Deliberately not a chatbot bubble
 * floating over the product: it is a working instrument panel — every answer
 * streams from the marine intelligence service, carries its confidence
 * self-assessment, can arrive in any of the twelve Bhashini languages, and
 * reports failures honestly instead of inventing content.
 */

import { useCallback, useEffect, useRef, useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

export type MonkMessage = {
  role: "user" | "assistant";
  content: string;
  confidence?: { score: number; label: "high" | "moderate" | "low"; justification: string } | null;
  error?: boolean;
  mode?: "ai" | "feeds";
};

/** The place the previous answer covered, echoed back so a follow-up
 * ("is the wind strong?", "what about tomorrow?") stays on it. */
type MonkContext = {
  location?: string | null;
  lat?: number | null;
  lon?: number | null;
  scope?: string | null;
  representative?: boolean;
};

const HISTORY_TURNS = 6;

function buildHistory(messages: MonkMessage[]) {
  return messages
    .filter((m) => m.content && m.content !== "…")
    .slice(-HISTORY_TURNS)
    .map((m) => ({ role: m.role, content: m.content }));
}

function contextFrom(location: any): MonkContext | null {
  if (!location) return null;
  return {
    location: location.label,
    lat: location.lat,
    lon: location.lon,
    scope: location.scope,
    representative: location.representative,
  };
}

const QUICK_PROMPTS = [
  "Is it safe to fish near Digha today?",
  "Where are the best fishing zones right now?",
  "Weather and waves off Sagar Island?",
];

/** Mirrors backend services/bhashini.py SUPPORTED_LANGUAGES. */
export const MONK_LANGUAGES: Record<string, string> = {
  en: "EN",
  hi: "हिंदी",
  bn: "বাংলা",
  ta: "தமிழ்",
  te: "తెలుగు",
  mr: "मराठी",
  gu: "ગુજરાતી",
  kn: "ಕನ್ನಡ",
  ml: "മലയാളം",
  pa: "ਪੰਜਾਬੀ",
  or: "ଓଡ଼ିଆ",
  ur: "اردو",
};

/* ------------------------------------------------------------------ markdown */

/**
 * Tiny, deliberately-limited markdown renderer: headings, bold, lists,
 * horizontal rules. The Monk's answers are structured safety briefs, not
 * arbitrary documents — a full markdown dependency is not needed here and
 * keeps the console bundle lean.
 */
function MonkMarkdown({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  const lines = text.split("\n");
  let list: string[] = [];

  const flushList = (key: string) => {
    if (!list.length) return;
    blocks.push(
      <ul key={key}>
        {list.map((li, i) => (
          <li key={i}>{inline(li)}</li>
        ))}
      </ul>
    );
    list = [];
  };

  lines.forEach((raw, idx) => {
    const line = raw.trimEnd();
    if (/^[-·]\s+/.test(line)) {
      list.push(line.replace(/^[-·]\s+/, ""));
      return;
    }
    flushList(`ul-${idx}`);
    if (!line.trim()) return;
    if (/^###\s+/.test(line)) {
      blocks.push(<h4 key={idx}>{inline(line.replace(/^###\s+/, ""))}</h4>);
    } else if (/^##?\s+/.test(line)) {
      blocks.push(<h3 key={idx}>{inline(line.replace(/^##?\s+/, ""))}</h3>);
    } else if (/^---+$/.test(line.trim())) {
      blocks.push(<hr key={idx} />);
    } else {
      blocks.push(<p key={idx}>{inline(line)}</p>);
    }
  });
  flushList("ul-end");

  return <div className="sk-monk-md">{blocks}</div>;
}

function inline(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|\*(.+?)\*|_([^_]+)_/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(<b key={k++}>{m[1]}</b>);
    else out.push(<i key={k++}>{m[2] ?? m[3]}</i>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/* ------------------------------------------------------------------ widget */

export function MonkChat({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [messages, setMessages] = useState<MonkMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [language, setLanguage] = useState("en");
  // resolved location carried into the next question
  const [chatContext, setChatContext] = useState<MonkContext | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 60);
  }, [open]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading, status]);

  const updateLast = useCallback((patch: Partial<MonkMessage>) => {
    setMessages((m) => {
      const next = [...m];
      next[next.length - 1] = { ...next[next.length - 1], ...patch };
      return next;
    });
  }, []);

  const send = useCallback(
    async (text: string, lang: string) => {
      const history = buildHistory(messages);
      const context = chatContext;
      setMessages((m) => [
        ...m,
        { role: "user", content: text },
        { role: "assistant", content: "…" },
      ]);
      setLoading(true);
      setStatus("Waking the Monk…");

      let streamed = "";
      let serverError: string | null = null;
      let confidence: MonkMessage["confidence"] = null;

      const consumeSse = async (res: Response) => {
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        const handleEvent = (event: string, raw: string) => {
          if (!raw) return;
          let data: any;
          try {
            data = JSON.parse(raw);
          } catch {
            return;
          }
          if (event === "token" && typeof data === "string") {
            streamed += data;
            updateLast({ content: streamed });
          } else if (event === "status" && data?.label) {
            setStatus(data.label);
          } else if (event === "final" && data) {
            if (data.confidence) confidence = data.confidence;
            if (data.location) setChatContext(contextFrom(data.location));
            if (data.response) {
              updateLast({ content: data.response, confidence });
            }
          } else if (event === "error" && data?.message) {
            serverError = data.message;
          }
        };
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sep: number;
          while ((sep = buffer.indexOf("\n\n")) !== -1) {
            const block = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            let event = "message";
            const dataLines: string[] = [];
            for (const line of block.split("\n")) {
              if (line.startsWith("event:")) event = line.slice(6).trim();
              else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
            }
            handleEvent(event, dataLines.join("\n"));
          }
        }
      };

      const showError = (message: string, partial = "") => {
        updateLast({
          content: partial ? `${partial}\n\n**Service unavailable:** ${message}` : `**Service unavailable:** ${message}`,
          error: true,
        });
      };

      try {
        const res = await fetch(`${API_URL}/api/chat/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text, language: lang, history, context }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          showError(body?.detail || `the marine intelligence service replied ${res.status}`, streamed);
          return;
        }
        if (res.body && res.headers.get("content-type")?.includes("text/event-stream")) {
          await consumeSse(res);
        } else {
          const data = await res.json();
          if (data.location) setChatContext(contextFrom(data.location));
          updateLast({ content: data.response ?? "", confidence: data.confidence ?? null });
        }
        if (serverError) showError(serverError, streamed);
      } catch {
        // Transport-level failure — retry once over plain JSON.
        try {
          const res = await fetch(`${API_URL}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: text, language: lang, history, context }),
          });
          if (!res.ok) {
            const body = await res.json().catch(() => null);
            throw new Error(body?.detail || `the service replied ${res.status}`);
          }
          const data = await res.json();
          if (data.location) setChatContext(contextFrom(data.location));
          updateLast({ content: data.response ?? "", confidence: data.confidence ?? null });
        } catch (err: any) {
          showError(err?.message || "the Monk could not be reached");
        }
      } finally {
        setStatus("");
        setLoading(false);
      }
    },
    [updateLast, messages, chatContext]
  );

  const submit = () => {
    const text = input.trim();
    if (!text || loading) return;
    setInput("");
    send(text, language);
  };

  return (
    <section
      className={`sk-monk ${open ? "is-open" : ""}`}
      role="dialog"
      aria-label="Ask the Monk — marine assistant"
      aria-hidden={!open}
    >
      <header className="sk-monk-head">
        <span className="sk-monk-mark" aria-hidden>
          {/* the monk glyph — a cowl over waves, drawn in the console icon family */}
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 4.5c0-1.4 1.8-2.5 4-2.5s4 1.1 4 2.5v3.2c0 1.4-1.8 2.5-4 2.5s-4-1.1-4-2.5V4.5Z" />
            <path d="M10 10v2.4M14 10v2.4" />
            <path d="M3 17c1.2 1 2.4 1 3.6 0s2.4-1 3.6 0 2.4 1 3.6 0 2.4-1 3.6 0 2.4 1 3.6 0" />
            <path d="M4.5 20.5c1.1.9 2.2.9 3.3 0s2.2-.9 3.3 0 2.2.9 3.3 0 2.2-.9 3.3 0" />
          </svg>
        </span>
        <span className="sk-monk-title">
          <b>Ask the Monk</b>
          <small>Live feeds · hazards · PFZ · advisories</small>
        </span>
        <span className="sk-spread" />
        <label className="sk-monk-lang">
          <span className="sk-sr">Reply language</span>
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            title="Answer language (Bhashini translation)"
          >
            {Object.entries(MONK_LANGUAGES).map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="sk-iconbtn" aria-label="Close the Monk" onClick={onClose}>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </header>

      <div className="sk-monk-prompts" role="group" aria-label="Suggested questions">
        {QUICK_PROMPTS.map((q) => (
          <button key={q} type="button" disabled={loading} onClick={() => send(q, language)}>
            {q}
          </button>
        ))}
      </div>

      <div ref={scrollRef} className="sk-monk-log" aria-live="polite">
        {messages.length === 0 ? (
          <div className="sk-monk-empty">
            <p>
              Ask about weather, waves, fishing zones, hazards, or whether a coordinate is safe to
              work — in any of twelve languages.
            </p>
            <small>
              Every answer states its sources and a confidence self-assessment.
              When a feed or the AI writer is unavailable, the Monk says so
              plainly instead of inventing an answer.
            </small>
          </div>
        ) : (
          messages.map((m, i) => (
            <div key={i} className={`sk-monk-msg ${m.role}${m.error ? " is-error" : ""}`}>
              {m.role === "assistant" ? (
                <>
                  <MonkMarkdown text={m.content} />
                  {m.confidence ? (
                    <span
                      className="sk-monk-conf"
                      data-label={m.confidence.label}
                      title={m.confidence.justification}
                    >
                      <i aria-hidden />
                      {m.confidence.score}% confidence · {m.confidence.label}
                    </span>
                  ) : null}
                </>
              ) : (
                m.content
              )}
            </div>
          ))
        )}
        {loading ? (
          <div className="sk-monk-status" role="status">
            <i className="sk-monk-spinner" aria-hidden />
            {status || "Working…"}
          </div>
        ) : null}
      </div>

      <div className="sk-monk-input">
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="Ask about the ocean…"
          aria-label="Question for the Monk"
          disabled={loading}
        />
        <button
          type="button"
          className="sk-monk-send"
          onClick={submit}
          disabled={loading || !input.trim()}
          aria-label="Send question"
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 11.5 19.5 4l-4.2 15.5-3.8-6.2L4 11.5Z" />
            <path d="M11.5 13.3 19.5 4" />
          </svg>
        </button>
      </div>
    </section>
  );
}

/** Floating launcher — a quiet, labelled control, not a glowing orb. */
export function MonkLauncher({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={`sk-monk-launch ${open ? "is-open" : ""}`}
      onClick={onToggle}
      aria-expanded={open}
      aria-controls="sk-monk-panel"
      title="Ask the Monk — marine assistant"
    >
      <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M8 4.5c0-1.4 1.8-2.5 4-2.5s4 1.1 4 2.5v3.2c0 1.4-1.8 2.5-4 2.5s-4-1.1-4-2.5V4.5Z" />
        <path d="M10 10v2.4M14 10v2.4" />
        <path d="M3 17c1.2 1 2.4 1 3.6 0s2.4-1 3.6 0 2.4 1 3.6 0 2.4-1 3.6 0 2.4 1 3.6 0" />
        <path d="M4.5 20.5c1.1.9 2.2.9 3.3 0s2.2-.9 3.3 0 2.2.9 3.3 0 2.2-.9 3.3 0" />
      </svg>
      <span>Ask the Monk</span>
    </button>
  );
}
