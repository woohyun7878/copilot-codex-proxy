import http from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import {
  authorizedLocalRequest, loadLocalKey, loadGithubAccessToken,
  validateCopilotEndpoint, githubJson, githubHeaders,
} from "./local-security.mjs";

const port = Number(process.argv.find((_, index, args) => args[index - 1] === "--port") ?? "17688");
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid proxy port");
const key = loadLocalKey();
const maxBodyBytes = 32 * 1024 * 1024;
let session;
let refreshing;

async function getSession() {
  if (session?.expires_at > Date.now() / 1000 + 60) return session;
  refreshing ??= (async () => {
    const token = await loadGithubAccessToken();
    const result = await githubJson("https://api.github.com/copilot_internal/v2/token", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!result.token || !result.endpoints?.api || !Number.isFinite(result.expires_at)) {
      throw new Error("GitHub returned an invalid Copilot session");
    }
    session = {
      token: result.token,
      expires_at: result.expires_at,
      endpoint: validateCopilotEndpoint(result.endpoints.api),
    };
    console.log(JSON.stringify({ event: "copilot_session", origin: session.endpoint.origin }));
    return session;
  })().finally(() => { refreshing = undefined; });
  return refreshing;
}

function json(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

function requestError(status, message) {
  return Object.assign(new Error(message), { status });
}

async function readBody(req) {
  if (Number(req.headers["content-length"]) > maxBodyBytes) {
    req.resume();
    throw requestError(413, "Request exceeds 32 MiB");
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > maxBodyBytes) {
      req.resume();
      throw requestError(413, "Request exceeds 32 MiB");
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw requestError(400, "Invalid JSON");
  }
  if (!parsed || typeof parsed.model !== "string" || !/^[a-z0-9._:/-]{1,200}$/i.test(parsed.model)) {
    throw requestError(400, "A valid model identifier is required");
  }
  return { body, model: parsed.model };
}

async function handle(req, res) {
  if (!authorizedLocalRequest(req, key, port)) {
    req.resume();
    json(res, 401, { error: { message: "Local proxy authentication required" } });
    return;
  }
  if (req.method === "GET" && req.url === "/health") {
    json(res, 200, { status: "ok", provider: "github-copilot" });
    return;
  }
  if (req.method === "GET" && req.url === "/usage") {
    const token = await loadGithubAccessToken();
    const usage = await githubJson("https://api.github.com/copilot_internal/user", {
      headers: { Authorization: `Bearer ${token}` },
    });
    json(res, 200, usage);
    return;
  }
  const models = req.method === "GET" && req.url === "/v1/models";
  const responses = req.method === "POST" && req.url === "/v1/responses";
  if (!models && !responses) {
    req.resume();
    json(res, 404, { error: { message: "Not found; only native Copilot Responses models are supported" } });
    return;
  }
  const payload = responses ? await readBody(req) : undefined;
  const current = await getSession();
  const prefix = current.endpoint.pathname.replace(/\/$/, "");
  const url = new URL(`${prefix}${models ? "/models" : "/v1/responses"}`, current.endpoint.origin);
  const controller = new AbortController();
  const close = () => { if (!res.writableFinished) controller.abort(); };
  res.on("close", close);
  const requestId = randomUUID();
  const started = Date.now();
  try {
    const upstream = await fetch(url, {
      method: req.method,
      headers: {
        ...githubHeaders,
        Authorization: `Bearer ${current.token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2026-06-01",
        "Openai-Intent": "conversation-agent",
        "X-Initiator": "user",
        "X-Request-Id": requestId,
      },
      body: payload?.body,
      redirect: "error",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(600_000)]),
    });
    if (upstream.status === 401) session = undefined;
    console.log(JSON.stringify({
      event: "copilot_request",
      request_id: requestId,
      upstream_request_id: upstream.headers.get("x-github-request-id") ?? upstream.headers.get("x-request-id"),
      method: req.method,
      path: req.url,
      model: payload?.model,
      origin: url.origin,
      status: upstream.status,
      headers_ms: Date.now() - started,
    }));
    res.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") ?? "application/json",
      "Cache-Control": "no-store",
      "X-Local-Proxy-Request-Id": requestId,
    });
    if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), res);
    else res.end();
  } finally {
    res.off("close", close);
  }
}

await getSession();
const server = http.createServer((req, res) => {
  handle(req, res).catch(error => {
    // Error bodies and request contents can contain private code or credentials.
    console.error(JSON.stringify({ event: "request_error", code: error.code ?? error.name }));
    if (res.destroyed) return;
    if (res.headersSent) res.destroy();
    else json(res, error.status ?? 502, {
      error: { message: error.status ? error.message : "GitHub Copilot request failed; check authentication and network access" },
    });
  });
});
server.headersTimeout = 30_000;
server.requestTimeout = 120_000;
server.on("error", error => {
  console.error(JSON.stringify({ event: "listener_error", code: error.code }));
  process.exitCode = 1;
});
server.listen(port, "127.0.0.1", () => {
  console.log(JSON.stringify({ event: "listening", address: `127.0.0.1:${port}` }));
});
