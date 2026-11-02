// tailnet-gate.cjs: a reverse proxy in front of one loopback port, for `tailscale serve`.
//
//   node tailnet-gate.cjs <listen port> <target port> <tailnet login>...
//
// preview-sandbox.sh --tailnet runs one per published port: `tailscale serve --https=<port>`
// sends tailnet requests here, and only requests from the given Tailscale logins reach
// 127.0.0.1:<target port>. Every other request gets 403, whatever the tailnet's access rules
// let reach the Mac (a device shared to another user, a tagged device, a looser ACL later).
//
// The identity is the Tailscale-User-Login header, which `tailscale serve` sets on each request
// it proxies from a user's device, replacing any value the client sent; it sets none for tagged
// devices. The gate listens on 127.0.0.1 only, so the one other way in is a local process, which
// can reach the target port directly anyway.
//
// Plain HTTP (streamed both ways, so server-sent events work) and WebSocket upgrades (Vite's hot
// reload, Mailpit's live list). CommonJS on purpose: it runs the same with any file name.
//
// Keep this file outside the repositories, where agents can't edit it.
"use strict";

const http = require("node:http");
const net = require("node:net");

const [listenArg, targetArg, ...loginArgs] = process.argv.slice(2);
const listenPort = Number(listenArg);
const targetPort = Number(targetArg);
const allowed = new Set(loginArgs.map((login) => login.trim().toLowerCase()).filter(Boolean));
if (!Number.isInteger(listenPort) || !Number.isInteger(targetPort) || allowed.size === 0) {
  console.error("usage: node tailnet-gate.cjs <listen port> <target port> <tailnet login>...");
  process.exit(2);
}

// Hop-by-hop headers describe one connection, not the request: never forwarded.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function endToEndHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP.has(name)) out[name] = value;
  }
  return out;
}

function admitted(req) {
  const login = req.headers["tailscale-user-login"];
  return typeof login === "string" && allowed.has(login.trim().toLowerCase());
}

const DENIED = "This preview is open only to the Mac's own Tailscale login.\n";
const agent = new http.Agent({ keepAlive: true });

const server = http.createServer((req, res) => {
  if (!admitted(req)) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    res.end(DENIED);
    req.resume();
    return;
  }
  const upstream = http.request(
    {
      host: "127.0.0.1",
      port: targetPort,
      method: req.method,
      path: req.url,
      headers: endToEndHeaders(req.headers),
      agent,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, endToEndHeaders(upstreamRes.headers));
      upstreamRes.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (res.headersSent) {
      res.destroy();
    } else {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end("The preview isn't answering on this port yet.\n");
    }
  });
  res.on("close", () => {
    if (!res.writableFinished) upstream.destroy();
  });
  req.pipe(upstream);
});

server.on("upgrade", (req, socket, head) => {
  if (!admitted(req)) {
    socket.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(DENIED)}\r\nConnection: close\r\n\r\n${DENIED}`);
    return;
  }
  const upstream = net.connect(targetPort, "127.0.0.1");
  const close = () => {
    socket.destroy();
    upstream.destroy();
  };
  upstream.on("connect", () => {
    // Node's parser has already rejected any header holding CR or LF, so rawHeaders is safe to
    // write back as is.
    let requestHead = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      requestHead += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    }
    upstream.write(`${requestHead}\r\n`);
    if (head && head.length > 0) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on("error", close);
  upstream.on("close", close);
  socket.on("error", close);
  socket.on("close", close);
});

// Longer than the idle timeout of Go's HTTP client in `tailscale serve` (90 s), so the gate never
// closes a pooled connection just as tailscale reuses it for a request.
server.keepAliveTimeout = 120_000;
server.headersTimeout = 125_000;
server.on("clientError", (_error, socket) => socket.destroy());
server.on("error", (error) => {
  console.error(`tailnet-gate: ${error.message}`);
  process.exit(1);
});
server.listen(listenPort, "127.0.0.1");
