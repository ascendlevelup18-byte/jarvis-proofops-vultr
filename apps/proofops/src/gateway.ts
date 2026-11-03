// Restricted HTTP gateway: the browser worker's only way out. One gateway per run.
// It is an HTTP forward proxy that accepts only absolute-form requests to the run's storefront session, and
// always forwards to a fixed upstream (the request's Host and authority never choose where bytes go).
// Refused: CONNECT (so no tunnels), protocol upgrades (WebSocket), other hosts or ports, paths outside the
// run's session, unexpected methods, oversized bodies. Every decision is logged with the run id.
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

export interface GatewayEvent {
  at: string;
  runId: string;
  decision: "allow" | "deny";
  reason: string;
  method: string;
  target: string;
  status?: number;
}

export interface GatewayOptions {
  runId: string;
  allowedHost: string; // e.g. store.proofops.test
  allowedPathPrefix: string; // e.g. /s/<sid>/
  upstream: { host: string; port: number }; // fixed storefront listener
  maxBodyBytes?: number;
  onEvent?: (e: GatewayEvent) => void;
}

const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST"]);
// Hop-by-hop and identifying headers the worker must not pass upstream.
const DROP_HEADERS = new Set(["proxy-connection", "proxy-authorization", "connection", "keep-alive", "upgrade", "te", "trailer",
  "transfer-encoding", "host", "x-forwarded-for", "forwarded", "x-proofops-approval"]);

export type Verdict = { ok: true; path: string } | { ok: false; status: number; reason: string };

/** Pure decision function (unit-tested separately from the socket plumbing). */
export function decide(method: string, rawTarget: string, headers: IncomingMessage["headers"], o: Pick<GatewayOptions, "allowedHost" | "allowedPathPrefix">): Verdict {
  if (method === "CONNECT") return { ok: false, status: 403, reason: "connect_refused" };
  if (headers.upgrade) return { ok: false, status: 403, reason: "upgrade_refused" };
  if (!ALLOWED_METHODS.has(method)) return { ok: false, status: 405, reason: "method_refused" };
  if (!/^http:\/\//i.test(rawTarget)) return { ok: false, status: 400, reason: "not_absolute_form" };
  let url: URL;
  try {
    url = new URL(rawTarget);
  } catch {
    return { ok: false, status: 400, reason: "bad_target" };
  }
  if (url.username || url.password) return { ok: false, status: 403, reason: "userinfo_refused" };
  if (url.hostname.toLowerCase() !== o.allowedHost || (url.port !== "" && url.port !== "80")) {
    return { ok: false, status: 403, reason: "host_not_allowed" };
  }
  // Compare the normalized path; URL() has already resolved dot segments.
  const path = url.pathname + url.search;
  if (!url.pathname.startsWith(o.allowedPathPrefix) || /%2e|%2f|%5c|\\/i.test(url.pathname)) {
    return { ok: false, status: 403, reason: "path_not_allowed" };
  }
  return { ok: true, path };
}

export function createGateway(o: GatewayOptions): Server {
  const maxBody = o.maxBodyBytes ?? 65_536;
  const emit = (e: Omit<GatewayEvent, "at" | "runId">) => o.onEvent?.({ at: new Date().toISOString(), runId: o.runId, ...e });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? "GET";
    const target = req.url ?? "";
    const v = decide(method, target, req.headers, o);
    if (!v.ok) {
      emit({ decision: "deny", reason: v.reason, method, target: target.slice(0, 300), status: v.status });
      res.writeHead(v.status, { "content-type": "text/plain", connection: "close" });
      res.end(`ProofOps gateway: ${v.reason}\n`);
      return;
    }
    const declared = Number(req.headers["content-length"] ?? "0");
    if (declared > maxBody) {
      emit({ decision: "deny", reason: "body_too_large", method, target, status: 413 });
      res.writeHead(413, { connection: "close" }).end();
      return;
    }
    const headers: Record<string, string | string[]> = {};
    for (const [k, val] of Object.entries(req.headers)) if (val !== undefined && !DROP_HEADERS.has(k)) headers[k] = val;
    headers.host = o.allowedHost;

    const up = httpRequest({ host: o.upstream.host, port: o.upstream.port, method, path: v.path, headers, timeout: 15_000 }, (upRes) => {
      emit({ decision: "allow", reason: "storefront", method, target, status: upRes.statusCode });
      const out: Record<string, string | string[]> = {};
      for (const [k, val] of Object.entries(upRes.headers)) if (val !== undefined && !DROP_HEADERS.has(k)) out[k] = val;
      res.writeHead(upRes.statusCode ?? 502, out);
      upRes.pipe(res);
    });
    up.on("timeout", () => up.destroy(new Error("upstream timeout")));
    up.on("error", () => {
      emit({ decision: "deny", reason: "upstream_error", method, target, status: 502 });
      if (!res.headersSent) res.writeHead(502).end();
      else res.destroy();
    });
    let seen = 0;
    req.on("data", (c: Buffer) => {
      seen += c.length;
      if (seen > maxBody) {
        up.destroy();
        req.destroy();
      }
    });
    req.pipe(up);
  });

  // CONNECT never reaches the request handler; refuse it explicitly and log it.
  server.on("connect", (req: IncomingMessage, socket: Socket) => {
    emit({ decision: "deny", reason: "connect_refused", method: "CONNECT", target: (req.url ?? "").slice(0, 300), status: 403 });
    socket.end("HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n");
  });
  server.on("upgrade", (req: IncomingMessage, socket: Socket) => {
    emit({ decision: "deny", reason: "upgrade_refused", method: req.method ?? "GET", target: (req.url ?? "").slice(0, 300), status: 403 });
    socket.end("HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n");
  });
  server.on("clientError", (_e, socket) => socket.destroy());
  return server;
}
