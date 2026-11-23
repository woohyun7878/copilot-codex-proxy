import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { once } from "node:events";
import { after, before, test } from "node:test";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-codex-proxy-test-"));
const priorLocalAppData = process.env.LOCALAPPDATA;
process.env.LOCALAPPDATA = temporary;
const security = await import("../local-security.mjs");
const key = "a".repeat(64);
const authorization = `Bearer ${key}`;
let child;
let logs = "";
let base;

before(async () => {
  fs.mkdirSync(security.stateDirectory, { recursive: true });
  fs.writeFileSync(security.localKeyPath, key);
  security.saveCredentials({ login: "test-identity", github_host: "github.com", access_token: "test-github-access" });
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [
    "--import", pathToFileURL(path.join(root, "test", "mock-upstream.mjs")).href,
    path.join(root, "server.mjs"), "--port", String(port),
  ], { env: { ...process.env, LOCALAPPDATA: temporary }, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.on("data", data => { logs += data; });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Proxy startup timed out: ${logs}`)), 10_000);
    child.once("error", reject);
    child.once("exit", code => {
      clearTimeout(timeout);
      reject(new Error(`Proxy exited with ${code}: ${logs}`));
    });
    child.stdout.on("data", data => {
      logs += data;
      if (logs.includes('"event":"listening"')) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
});

after(async () => {
  if (child && child.exitCode === null) {
    const exit = once(child, "exit");
    child.kill();
    await exit;
  }
  if (priorLocalAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = priorLocalAppData;
  fs.rmSync(temporary, { recursive: true });
});

test("upstream endpoints reject non-Copilot hosts, HTTP, credentials, and alternate ports", () => {
  assert.equal(security.validateCopilotEndpoint("https://api.enterprise.githubcopilot.com").hostname, "api.enterprise.githubcopilot.com");
  for (const endpoint of [
    "https://api.openai.com", "http://api.githubcopilot.com",
    "https://api.githubcopilot.com.evil.invalid", "https://evilgithubcopilot.com",
    "https://user:password@api.githubcopilot.com", "https://api.githubcopilot.com:8443",
    "https://api.githubcopilot.com?redirect=evil",
  ]) {
    assert.throws(() => security.validateCopilotEndpoint(endpoint));
  }
});

test("all local endpoints reject missing or incorrect keys and browser-origin requests", async () => {
  for (const route of ["/health", "/usage", "/v1/models", "/v1/responses"]) {
    assert.equal((await fetch(base + route)).status, 401);
  }
  assert.equal((await fetch(base + "/health", { headers: { Authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await fetch(base + "/health", { headers: { Authorization: authorization, Origin: "https://example.com" } })).status, 401);
  assert.equal(security.authorizedLocalRequest({ headers: { host: "evil.invalid", authorization } }, key, 17688), false);
  const health = await fetch(base + "/health", { headers: { Authorization: authorization } });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).provider, "github-copilot");
  assert.equal(health.headers.get("access-control-allow-origin"), null);
});

test("models and usage use dedicated GitHub/Copilot credentials", async () => {
  const models = await fetch(base + "/v1/models", { headers: { Authorization: authorization } });
  assert.equal((await models.json()).data[0].id, "test-native-responses-model");
  const usage = await fetch(base + "/usage", { headers: { Authorization: authorization } });
  assert.equal((await usage.json()).copilot_plan, "enterprise");
});

async function inference(body) {
  return fetch(base + "/v1/responses", {
    method: "POST",
    headers: { Authorization: authorization, "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("native JSON and SSE Responses retain content and replace client authorization", async () => {
  for (const stream of [false, true]) {
    const response = await inference({ model: "test-native-responses-model", input: "private-synthetic-prompt", stream });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /SYNTHETIC_OK/);
    assert.ok(response.headers.get("x-local-proxy-request-id"));
    if (stream) assert.match(response.headers.get("content-type"), /text\/event-stream/);
  }
});

test("invalid inputs and unsupported models fail explicitly, without fallback", async () => {
  assert.equal((await inference("{")).status, 400);
  assert.equal((await inference(null)).status, 400);
  assert.equal((await inference({ model: "bad\nmodel", input: "synthetic" })).status, 400);
  assert.equal((await inference({ model: "unsupported-model", input: "synthetic" })).status, 400);
  assert.equal((await fetch(base + "/v1/chat/completions", { headers: { Authorization: authorization } })).status, 404);
});

test("local logs exclude prompt text, upstream error bodies, and credentials", async () => {
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.match(logs, /"origin":"https:\/\/api\.enterprise\.githubcopilot\.com"/);
  for (const secret of [key, "test-github-access", "test-copilot-session", "private-synthetic-prompt", "private-upstream-error"]) {
    assert.equal(logs.includes(secret), false);
  }
});

test("expiring GitHub credentials renew with the Copilot OAuth client and retain identity", async () => {
  const originalFetch = globalThis.fetch;
  security.saveCredentials({
    login: "test-identity", github_host: "github.com",
    access_token: "expired-access", refresh_token: "test-refresh", expires_at: 1,
  });
  let calls = 0;
  globalThis.fetch = async (input, options) => {
    calls++;
    assert.equal(String(input), "https://github.com/login/oauth/access_token");
    assert.equal(options.redirect, "error");
    assert.equal(options.body.get("grant_type"), "refresh_token");
    assert.equal(options.body.get("client_id"), security.clientId);
    assert.equal(options.body.get("refresh_token"), "test-refresh");
    return Response.json({ access_token: "renewed-access", refresh_token: "rotated-refresh", expires_in: 3600 });
  };
  try {
    assert.deepEqual(await Promise.all([
      security.loadGithubAccessToken(), security.loadGithubAccessToken(),
    ]), ["renewed-access", "renewed-access"]);
    assert.equal(calls, 1);
    const stored = JSON.parse(fs.readFileSync(security.credentialPath, "utf8"));
    assert.equal(stored.login, "test-identity");
    assert.equal(stored.refresh_token, "rotated-refresh");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("authentication refuses unapproved hosts and expired credentials without refresh tokens", async () => {
  await assert.rejects(security.githubJson("https://unverified.invalid/login"), /Rejected non-GitHub/);
  security.saveCredentials({ login: "test-identity", github_host: "other.example", access_token: "not-used" });
  await assert.rejects(security.loadGithubAccessToken(), /approved GitHub identity/);
  security.saveCredentials({ login: "test-identity", github_host: "github.com", access_token: "expired", expires_at: 1 });
  await assert.rejects(security.loadGithubAccessToken(), /login expired/);
});
