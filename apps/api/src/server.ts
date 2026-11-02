// POST /cases -> final case result, through the shared ingress guard. GET /api/health, GET /api/demo-store.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { demoStoreSnapshot } from "./demo-store.ts";
import { clientKeyFrom, handleCaseRequest, MAX_BODY_BYTES, type CaseIngress } from "./ingress.ts";
import { handleTeamRequest, TEAM_MAX_BODY_BYTES, type TeamDeps } from "./team/routes.ts";

export interface AppOptions {
  /** Key rate limits on X-Forwarded-For (only behind a trusted proxy). */
  trustProxy?: boolean;
  /** Body for GET /api/health; must describe the actual runtime mode. */
  health?: () => unknown;
  /** Operator-only AI Team endpoints; absent = /team/* answers 404. */
  team?: TeamDeps;
}

export function createApp(ingress: CaseIngress, opts: AppOptions = {}): Server {
  return createServer((req, res) => {
    handle(req, res, ingress, opts).catch((e: unknown) => {
      console.error("[jarvis] request failed:", e);
      if (!res.headersSent) send(res, 500, { error: "internal_error" });
      else res.end();
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, ingress: CaseIngress, opts: AppOptions): Promise<void> {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  if (path === "/api/health" && opts.health) {
    return req.method === "GET" ? send(res, 200, opts.health()) : send(res, 405, { error: "method_not_allowed" });
  }
  if (path === "/api/demo-store") {
    return req.method === "GET" ? send(res, 200, demoStoreSnapshot(ingress.clock)) : send(res, 405, { error: "method_not_allowed" });
  }
  if (path.startsWith("/team/")) {
    const parts: Buffer[] = [];
    let n = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      n += chunk.length;
      if (n <= TEAM_MAX_BODY_BYTES) parts.push(chunk);
    }
    const r = await handleTeamRequest(path, req.method ?? "GET", req.headers.authorization, n > TEAM_MAX_BODY_BYTES ? null : Buffer.concat(parts).toString("utf8"), opts.team ?? { provider: null, accessToken: null });
    return send(res, r.status, r.body, r.headers);
  }
  if (path !== "/cases") return send(res, 404, { error: "not_found" });

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size <= MAX_BODY_BYTES) chunks.push(chunk);
  }
  const forwarded = req.headers["x-forwarded-for"];
  const r = await handleCaseRequest(
    {
      method: req.method ?? "GET",
      bodyText: size > MAX_BODY_BYTES ? null : Buffer.concat(chunks).toString("utf8"),
      authorization: req.headers.authorization,
      clientKey: clientKeyFrom(req.socket.remoteAddress, Array.isArray(forwarded) ? forwarded[0] : forwarded, opts.trustProxy ?? false),
    },
    ingress,
  );
  send(res, r.status, r.body, r.headers);
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}
