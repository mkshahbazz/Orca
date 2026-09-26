"use client";

import { useCallback, useRef, useState } from "react";
import dynamic from "next/dynamic";
import ChatDrawer from "@/components/ChatDrawer";

const MapView = dynamic(() => import("@/components/MapView"), {
  ssr: false,
  loading: () => <div className="h-full w-full animate-pulse bg-sky-200" />,
});

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface MapFeatureCollection {
  type: string;
  features: unknown[];
}

export default function MarineChatApp() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [mapFeatures, setMapFeatures] = useState<MapFeatureCollection | null>(
    null
  );
  const [mapVersion, setMapVersion] = useState(0);
  const streamFailed = useRef(false); // fall back to JSON after a stream error

  const appendAssistant = useCallback((content: string) => {
    setMessages((m) => [...m, { role: "assistant", content }]);
  }, []);

  const sendMessage = useCallback(
    async (text: string) => {
      setMessages((m) => [...m, { role: "user", content: text }]);
      setLoading(true);

      // placeholder bubble we stream into
      const placeholder = "\u2026";
      setMessages((m) => [...m, { role: "assistant", content: placeholder }]);
      const updateLast = (content: string) =>
        setMessages((m) => {
          const next = [...m];
          next[next.length - 1] = { role: "assistant", content };
          return next;
        });

      let streamed = "";
      let features: MapFeatureCollection | null = null;

      const consumeSse = async (res: Response) => {
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let intent = "";

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
          } else if (event === "final" && data) {
            if (data.response && !streamed) updateLast(data.response);
            if (data.map_features?.features?.length)
              features = data.map_features;
            intent = data.intent || intent;
          } else if (event === "error" && data?.message) {
            throw new Error(data.message);
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
        return intent;
      };

      try {
        const res = await fetch(`${API_URL}/api/chat/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text }),
        });

        if (res.ok && res.body && res.headers.get("content-type")?.includes("text/event-stream")) {
          await consumeSse(res);
        } else {
          // non-streaming fallback (older backend, proxies, unexpected payload)
          const data = await res.json();
          updateLast(data.response ?? "");
          if (data.map_features?.features?.length)
            features = data.map_features;
        }

        if (features) {
          setMapFeatures(features);
          setMapVersion((v) => v + 1);
        }
      } catch (err: any) {
        if (!streamed) {
          // stream never produced anything — retry once over plain JSON
          try {
            const res = await fetch(`${API_URL}/api/chat`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ message: text }),
            });
            if (!res.ok) throw new Error(`Backend ${res.status}`);
            const data = await res.json();
            updateLast(data.response);
            if (data.map_features?.features?.length) {
              setMapFeatures(data.map_features);
              setMapVersion((v) => v + 1);
            }
          } catch (err2: any) {
            appendAssistant(`⚠️ **Error:** ${err2.message}`);
          }
        } else {
          appendAssistant(`⚠️ **Stream interrupted:** ${err.message}`);
        }
      } finally {
        setLoading(false);
        streamFailed.current = false;
      }
    },
    [appendAssistant]
  );

  return (
    <main className="relative h-screen w-screen overflow-hidden">
      <MapView mapFeatures={mapFeatures} refreshKey={mapVersion} />
      <ChatDrawer messages={messages} loading={loading} onSend={sendMessage} />
    </main>
  );
}
