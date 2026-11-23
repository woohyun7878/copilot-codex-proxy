import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";

export const stateDirectory = path.join(
  process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".local", "share"),
  "CopilotCodexProxy",
  "state",
);
export const credentialPath = path.join(stateDirectory, "github.json");
export const localKeyPath = path.join(stateDirectory, "local-api-key");
export const clientId = "Iv1.b507a08c87ecfe98";
export const githubHeaders = {
  Accept: "application/json",
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
};

export function validateCopilotEndpoint(raw) {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    (url.hostname !== "api.githubcopilot.com" &&
      !url.hostname.endsWith(".githubcopilot.com")) ||
    url.username || url.password || url.port || url.search || url.hash
  ) {
    throw new Error("Rejected non-GitHub-Copilot inference endpoint");
  }
  return url;
}

export function authorizedLocalRequest(req, key, port) {
  if (req.headers.origin || req.headers.host !== `127.0.0.1:${port}`) return false;
  const actual = Buffer.from(req.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${key}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function loadLocalKey() {
  const key = fs.readFileSync(localKeyPath, "utf8").trim();
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid local proxy API key");
  return key;
}

export async function githubJson(url, options = {}) {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    !["github.com", "api.github.com"].includes(parsed.hostname) ||
    parsed.username || parsed.password || parsed.port
  ) {
    throw new Error("Rejected non-GitHub authentication endpoint");
  }
  const response = await fetch(parsed, {
    ...options,
    headers: { ...githubHeaders, ...options.headers },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GitHub endpoint returned HTTP ${response.status}`);
  return response.json();
}

export function oauthForm(fields) {
  return githubJson("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, ...fields }),
  });
}

export function saveCredentials(credentials) {
  const temporary = `${credentialPath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(credentials)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, credentialPath);
}

let refreshing;
export async function loadGithubAccessToken() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const credentials = JSON.parse(fs.readFileSync(credentialPath, "utf8"));
    if (
      typeof credentials.login !== "string" ||
      !credentials.login ||
      credentials.github_host !== "github.com" ||
      typeof credentials.access_token !== "string" ||
      !credentials.access_token
    ) {
      throw new Error("Dedicated proxy credentials do not match the approved GitHub identity");
    }
    if (credentials.expires_at && Date.now() >= credentials.expires_at - 300_000) {
      if (!credentials.refresh_token) throw new Error("GitHub login expired; run authenticate.mjs again");
      const renewed = await oauthForm({
        grant_type: "refresh_token",
        refresh_token: credentials.refresh_token,
      });
      if (!renewed.access_token || renewed.error) throw new Error("GitHub token renewal failed; authenticate again");
      credentials.access_token = renewed.access_token;
      credentials.refresh_token = renewed.refresh_token ?? credentials.refresh_token;
      credentials.expires_at = renewed.expires_in ? Date.now() + renewed.expires_in * 1000 : null;
      saveCredentials(credentials);
    }
    return credentials.access_token;
  })();
  try {
    return await refreshing;
  } finally {
    refreshing = undefined;
  }
}
