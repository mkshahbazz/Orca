"""Local SSE mock of the backend chat endpoints (stdlib only).

Serves CORS-enabled /api/chat/stream + /api/chat on :8765 so the Monk window
can be exercised in a browser without the real backend (whose CORS allowlist
does not include localhost).
"""
from http.server import BaseHTTPRequestHandler, HTTPServer

TOKENS = [
    "**Feed brief for 21.40°N, 87.90°E**\n\n",
    "### Observed conditions — Open-Meteo\n",
    "- Wind: **6 kt**, gusting 8 kt\n- Waves: **1.4 m** at 9 s from SW\n\n",
    "→ **Favourable** — small craft can work the nearshore grounds.\n\n",
    "### Hazard geofence — PostGIS\n✅ No recorded hazard zone at this location.\n",
]


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "content-type")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("content-length", 0))
        self.rfile.read(length)
        if self.path == "/api/chat/stream":
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()

            def sse(event, payload):
                import json
                self.wfile.write(f"event: {event}\ndata: {json.dumps(payload)}\n\n".encode())
                self.wfile.flush()

            sse("status", {"stage": "routed", "label": "Understanding your question…"})
            import time
            for t in TOKENS:
                time.sleep(0.25)
                sse("token", t)
            sse("status", {"stage": "verifying", "label": "Cross-checking human reports…"})
            sse("final", {
                "response": "".join(TOKENS),
                "confidence": {"score": 86, "label": "high",
                               "justification": "Two independent live feeds agree; no conflicting reports."},
                "map_features": {"type": "FeatureCollection", "features": []},
            })
        elif self.path == "/api/chat":
            import json
            body = json.dumps({
                "response": "".join(TOKENS),
                "confidence": {"score": 86, "label": "high", "justification": "ok"},
            }).encode()
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self._cors()
            self.end_headers()

    def log_message(self, *a):
        pass


HTTPServer(("127.0.0.1", 8765), Handler).serve_forever()
