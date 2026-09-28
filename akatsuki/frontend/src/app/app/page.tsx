"use client";

import { useCallback, useState } from "react";
import dynamic from "next/dynamic";
import ChatDrawer from "@/components/ChatDrawer";

const MapView = dynamic(() => import("@/components/MapView"), {
  ssr: false,
  loading: () => <div className="h-full w-full animate-pulse bg-sky-200" />,
});

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

/** Self-assessment shipped out-of-band of the streamed answer text. */
export interface Confidence {
  score: number;
  label: "high" | "moderate" | "low";
  justification: string;
  factors?: string[];
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  confidence?: Confidence | null;
  error?: boolean;
}

interface MapFeatureCollection {
  type: string;
  features: unknown[];
}

/** The location the previous answer was for, echoed back so a follow-up like
 * "is the wind strong?" stays on the same place. Sent as `context`. */
interface ChatContext {
  location?: string | null;
  lat?: number | null;
  lon?: number | null;
  scope?: string | null;
  representative?: boolean;
}

/** How many recent turns are sent so the backend can follow the conversation. */
const HISTORY_TURNS = 6;

function buildHistory(messages: ChatMessage[]) {
  return messages
    .filter((m) => m.content && m.content !== "\u2026")
    .slice(-HISTORY_TURNS)
    .map((m) => ({ role: m.role, content: m.content }));
}

export default function MarineChatApp() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [language, setLanguage] = useState("en");
  // resolved location carried into the next question
  const [chatContext, setChatContext] = useState<ChatContext | null>(null);
  const [mapFeatures, setMapFeatures] = useState<MapFeatureCollection | null>(
    null
  );
  const [mapVersion, setMapVersion] = useState(0);

  const appendAssistant = useCallback(
    (content: string, error = false) => {
      setMessages((m) => [...m, { role: "assistant", content, error }]);
    },
    []
  );

  const sendMessage = useCallback(
    async (text: string, lang: string = "en") => {
      const history = buildHistory(messages);
      const context = chatContext;
      setMessages((m) => [...m, { role: "user", content: text }]);
      setLoading(true);
      setStatus("Contacting the marine intelligence service…");

      // placeholder bubble we stream into
      const placeholder = "\u2026";
      setMessages((m) => [...m, { role: "assistant", content: placeholder }]);
      const updateLast = (
        content: string,
        confidence?: Confidence | null,
        error = false
      ) =>
        setMessages((m) => {
          const next = [...m];
          next[next.length - 1] = {
            role: "assistant",
            content,
            confidence: confidence ?? next[next.length - 1]?.confidence ?? null,
            error,
          };
          return next;
        });

      let streamed = "";
      let features: MapFeatureCollection | null = null;
      let serverError: string | null = null;
      let confidence: Confidence | null = null;

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
            updateLast(streamed);
          } else if (event === "status" && data) {
            // live transparency: show exactly what the backend is doing
            if (data.label) setStatus(data.label);
          } else if (event === "final" && data) {
            if (data.confidence) confidence = data.confidence;
            if (data.location) {
              // keep the resolved place for the next question (follow-ups)
              setChatContext({
                location: data.location.label,
                lat: data.location.lat,
                lon: data.location.lon,
                scope: data.location.scope,
                representative: data.location.representative,
              });
            }
            if (data.response && !streamed) {
              // translated answers arrive whole (English tokens are withheld)
              updateLast(data.response, confidence);
            } else {
              updateLast(streamed || data.response || "", confidence);
            }
            if (data.map_features?.features?.length)
              features = data.map_features;
          } else if (event === "error" && data?.message) {
            // genuine failure from the backend — never masked with fake data
            serverError = data.message;
          }
        };

        while (true) {
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
        const body = `⚠️ **Service unavailable:** ${message}`;
        updateLast(partial ? `${partial}\n\n${body}` : body, null, true);
      };

      try {
        const res = await fetch(`${API_URL}/api/chat/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text, language: lang, history, context }),
        });

        if (!res.ok) {
          // the backend refuses with a real reason — surface it, never mask it
          const body = await res.json().catch(() => null);
          showError(body?.detail || `backend returned ${res.status}`, streamed);
          return;
        }

        if (res.body && res.headers.get("content-type")?.includes("text/event-stream")) {
          await consumeSse(res);
        } else {
          // non-streaming payload (older backend, proxies, unexpected body)
          const data = await res.json();
          updateLast(data.response ?? "", data.confidence ?? null);
          if (data.location)
            setChatContext({
              location: data.location.label,
              lat: data.location.lat,
              lon: data.location.lon,
              scope: data.location.scope,
              representative: data.location.representative,
            });
          if (data.map_features?.features?.length)
            features = data.map_features;
        }

        if (serverError) {
          showError(serverError, streamed);
          return;
        }

        if (features) {
          setMapFeatures(features);
          setMapVersion((v) => v + 1);
        }
      } catch (err: any) {
        if (!streamed) {
          // transport-level failure — retry once over plain JSON
          try {
            const res = await fetch(`${API_URL}/api/chat`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ message: text, language: lang, history, context }),
            });
            if (!res.ok) {
              const body = await res.json().catch(() => null);
              throw new Error(body?.detail || `Backend ${res.status}`);
            }
            const data = await res.json();
            updateLast(data.response, data.confidence ?? null);
            if (data.map_features?.features?.length) {
              setMapFeatures(data.map_features);
              setMapVersion((v) => v + 1);
            }
          } catch (err2: any) {
            appendAssistant(`⚠️ **Service unavailable:** ${err2.message}`, true);
          }
        } else {
          appendAssistant(`⚠️ **Answer interrupted:** ${err.message}`, true);
        }
      } finally {
        setStatus("");
        setLoading(false);
      }
    },
    [appendAssistant, messages, chatContext]
  );

  return (
    <main className="relative h-screen w-screen overflow-hidden">
      <MapView mapFeatures={mapFeatures} refreshKey={mapVersion} />
      <ChatDrawer
        messages={messages}
        loading={loading}
        status={status}
        language={language}
        onLanguageChange={setLanguage}
        onSend={sendMessage}
      />
    </main>
  );
}
