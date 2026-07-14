import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { logger } from "./logger.js";

/**
 * A client transport that bridges to a *remote, stateful* legacy MCP server
 * over Streamable HTTP. The legacy server expects the removed `Mcp-Session-Id`
 * header; this transport owns that session; performs `initialize` on behalf of
 * the SDK `Client` (which sends it via `send()`), and injects the cached session
 * id onto every subsequent request. This is the Phase 4 remote-HTTP backend.
 *
 * The stateless 2026-07-28 front end is untouched — it talks to the same
 * `LegacyClientManager`, which is transport-agnostic.
 */
export class RemoteHttpClientTransport implements Transport {
  private sessionIdValue: string | null = null;
  private connected = false;
  private readonly abort = new AbortController();
  private readonly delivered = new Set<string>();

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  /** Public per the `Transport` interface — reflects the current legacy session id. */
  get sessionId(): string | undefined {
    return this.sessionIdValue ?? undefined;
  }

  constructor(private readonly remoteUrl: string) {}

  async start(): Promise<void> {
    logger.info({ remoteUrl: this.remoteUrl }, "connecting to remote legacy HTTP server");
    this.connected = true;
    void this.openGetStream();
  }

  private async openGetStream(): Promise<void> {
    const headers: Record<string, string> = { Accept: "text/event-stream" };
    if (this.sessionIdValue) headers["Mcp-Session-Id"] = this.sessionIdValue;
    try {
      const res = await fetch(this.remoteUrl, { method: "GET", headers, signal: this.abort.signal });
      if (!res.ok || !res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const { messages, remaining } = takeComplete(buf);
        buf = remaining;
        for (const m of messages) this.deliver(m);
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      logger.warn({ err: (err as Error).message }, "remote GET stream ended");
    }
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (!this.connected) throw new Error("RemoteHttpClientTransport not started");

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.sessionIdValue) headers["Mcp-Session-Id"] = this.sessionIdValue;

    const res = await fetch(this.remoteUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
      signal: this.abort.signal,
    });

    // Capture the session id from the initialize response headers.
    const sid = res.headers.get("mcp-session-id") ?? res.headers.get("X-Mcp-Session-Id");
    if (sid) this.sessionIdValue = sid;

    if (res.status === 202 || res.status === 204) return;

    const text = await res.text();
    for (const m of parseBody(text)) this.deliver(m);
  }

  private deliver(message: JSONRPCMessage): void {
    const id = (message as { id?: unknown }).id;
    if (id !== undefined) {
      const key = String(id);
      if (this.delivered.has(key)) return; // dedupe against GET-stream delivery
      this.delivered.add(key);
    }
    this.onmessage?.(message);
  }

  async close(): Promise<void> {
    this.connected = false;
    this.abort.abort();
    this.onclose?.();
  }
}

/** Extract complete SSE events (blocks separated by a blank line). */
function takeComplete(buffer: string): { messages: JSONRPCMessage[]; remaining: string } {
  const messages: JSONRPCMessage[] = [];
  let remaining = buffer;
  let idx: number;
  while ((idx = remaining.indexOf("\n\n")) !== -1) {
    const block = remaining.slice(0, idx);
    remaining = remaining.slice(idx + 2);
    let data = "";
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("data:")) data += line.slice(5).replace(/^ /, "");
    }
    if (data) {
      try {
        messages.push(JSON.parse(data));
      } catch {
        /* ignore malformed */
      }
    }
  }
  return { messages, remaining };
}

/** Parse a complete POST body: plain JSON (object or array) or an SSE stream. */
function parseBody(text: string): JSONRPCMessage[] {
  const t = text.trim();
  if (!t) return [];
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      const parsed = JSON.parse(t);
      return (Array.isArray(parsed) ? parsed : [parsed]) as JSONRPCMessage[];
    } catch {
      return [];
    }
  }
  return takeComplete(text).messages;
}
