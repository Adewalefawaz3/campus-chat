// One Durable Object per room. It ONLY relays live events to connected sockets.
// It never stores anything: PostgreSQL is the single source of truth.
export class Room {
  ctx: DurableObjectState;
  constructor(ctx: DurableObjectState, _env: unknown) {
    this.ctx = ctx;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // Called by the Worker AFTER a successful database write.
    if (url.pathname === "/broadcast" && req.method === "POST") {
      const payload = await req.text();
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.send(payload);
        } catch {}
      }
      return new Response("ok");
    }

    if (req.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response("Not found", { status: 404 });
  }

  webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) {
    if (msg === "ping") ws.send("pong");
  }
  webSocketClose(ws: WebSocket) {
    try {
      ws.close(1000);
    } catch {}
  }
}
