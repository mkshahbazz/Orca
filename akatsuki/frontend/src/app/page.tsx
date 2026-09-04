"use client";

import { useCallback, useState } from "react";
import dynamic from "next/dynamic";
import ChatDrawer from "@/components/ChatDrawer";

const MapView = dynamic(() => import("@/components/MapView"), {
  ssr: false,
  loading: () => <div className="h-full w-full animate-pulse bg-sky-200" />,
});

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export default function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [mapFeatures, setMapFeatures] = useState<any>(null);
  const [mapVersion, setMapVersion] = useState(0);

  const sendMessage = useCallback(async (text: string) => {
    const userMsg: ChatMessage = { role: "user", content: text };
    setMessages((m) => [...m, userMsg]);
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      if (!res.ok) throw new Error(`Backend ${res.status}: ${await res.text()}`);
      const data = await res.json();
      setMessages((m) => [...m, { role: "assistant", content: data.response }]);
      if (data.map_features?.features?.length) {
        setMapFeatures(data.map_features);
        setMapVersion((v) => v + 1);
      }
    } catch (err: any) {
      setMessages((m) => [
        ...m,
        { role: "assistant", content: `⚠️ **Error:** ${err.message}` },
      ]);
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <main className="relative h-screen w-screen overflow-hidden">
      <MapView mapFeatures={mapFeatures} refreshKey={mapVersion} />
      <ChatDrawer messages={messages} loading={loading} onSend={sendMessage} />
    </main>
  );
}
