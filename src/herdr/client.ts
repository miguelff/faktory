import { createConnection, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

/**
 * Minimal client for herdr's newline-delimited JSON socket API.
 * One connection multiplexes request/response by id; a second long-lived
 * connection (subscribe) streams events.
 */
export interface HerdrResponse {
  id: string;
  result?: unknown;
  error?: { code?: string; message?: string };
}

export class HerdrClient extends EventEmitter {
  constructor(private readonly socketPath: string) {
    super();
  }

  static fromEnv(): HerdrClient {
    const path = process.env.HERDR_SOCKET_PATH;
    if (!path) throw new Error("HERDR_SOCKET_PATH is not set — run Faktory inside herdr.");
    return new HerdrClient(path);
  }

  /** Single request/response round trip on a fresh connection. */
  async request<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    const id = randomUUID();
    const sock = await this.connect();
    try {
      sock.write(JSON.stringify({ id, method, params }) + "\n");
      const msg = await readLines(sock, (m) => m.id === id, timeoutMs);
      if (msg.error) throw new HerdrError(method, msg.error);
      return msg.result as T;
    } finally {
      sock.destroy();
    }
  }

  /**
   * Long-lived event subscription. Emits `event` with each subscription event
   * and `close` when the socket drops. Returns a disposer.
   */
  async subscribe(types: string[], onEvent: (ev: any) => void): Promise<() => void> {
    const id = randomUUID();
    const sock = await this.connect();
    sock.write(
      JSON.stringify({ id, method: "events.subscribe", params: { subscriptions: types.map((type) => ({ type })) } }) +
        "\n",
    );
    let acked = false;
    feedLines(sock, (msg) => {
      if (!acked && msg.id === id) {
        acked = true;
        if (msg.error) this.emit("error", new HerdrError("events.subscribe", msg.error));
        return;
      }
      onEvent(msg);
    });
    sock.on("close", () => this.emit("close"));
    return () => sock.destroy();
  }

  private connect(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const sock = createConnection(this.socketPath, () => resolve(sock));
      sock.once("error", reject);
    });
  }
}

export class HerdrError extends Error {
  constructor(
    method: string,
    readonly detail: { code?: string; message?: string },
  ) {
    super(`herdr ${method} failed: ${detail.code ?? ""} ${detail.message ?? JSON.stringify(detail)}`.trim());
  }
}

function feedLines(sock: Socket, onMsg: (msg: any) => void): void {
  let buf = "";
  sock.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        onMsg(JSON.parse(line));
      } catch {
        /* ignore malformed lines */
      }
    }
  });
}

function readLines(sock: Socket, match: (msg: any) => boolean, timeoutMs: number): Promise<HerdrResponse> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("herdr socket timeout")), timeoutMs);
    feedLines(sock, (msg) => {
      if (match(msg)) {
        clearTimeout(timer);
        resolve(msg);
      }
    });
    sock.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    sock.once("close", () => {
      clearTimeout(timer);
      reject(new Error("herdr socket closed"));
    });
  });
}
