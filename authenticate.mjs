import fs from "node:fs";
import { randomBytes } from "node:crypto";
import {
  clientId, stateDirectory, localKeyPath,
  githubJson, oauthForm, saveCredentials, validateCopilotEndpoint,
} from "./local-security.mjs";

// OAuth client, form encoding, scope, and headers follow ai.rs's Copilot helper.
async function authenticate() {
  const expectedLogin = process.argv.find((_, index, args) => args[index - 1] === "--login");
  if (!expectedLogin || !/^[a-z0-9_-]+$/i.test(expectedLogin)) {
    throw new Error("Specify the approved GitHub identity with --login LOGIN");
  }
  const device = await githubJson("https://github.com/login/device/code", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, scope: "read:user" }),
  });
  if (!device.device_code || !device.user_code || !device.expires_in) {
    throw new Error("GitHub returned an invalid device authorization response");
  }
  if (device.verification_uri !== "https://github.com/login/device") {
    throw new Error("GitHub returned an unexpected device authorization URL");
  }
  console.log(`Authorize account ${expectedLogin} at https://github.com/login/device`);
  console.log(`Device authorization code: ${device.user_code}`);
  console.log(`Expires in ${device.expires_in} seconds. No token will be printed.`);

  const deadline = Date.now() + device.expires_in * 1000;
  let interval = Math.max(5, device.interval ?? 5);
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, interval * 1000));
    const result = await oauthForm({
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    if (result.error === "authorization_pending") continue;
    if (result.error === "slow_down") {
      interval += 5;
      continue;
    }
    if (result.error || !result.access_token) throw new Error("Device authorization was denied or expired");
    const headers = { Authorization: `Bearer ${result.access_token}` };
    const user = await githubJson("https://api.github.com/user", { headers });
    if (user.login.toLowerCase() !== expectedLogin.toLowerCase()) {
      throw new Error(`Authorized account was not ${expectedLogin}; credentials were not saved`);
    }
    const copilot = await githubJson("https://api.github.com/copilot_internal/v2/token", { headers });
    if (!copilot.token || !copilot.endpoints?.api) throw new Error("No Copilot entitlement or inference endpoint");
    const endpoint = validateCopilotEndpoint(copilot.endpoints.api);
    fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
    saveCredentials({
      github_host: "github.com",
      login: user.login,
      access_token: result.access_token,
      refresh_token: result.refresh_token,
      expires_at: result.expires_in ? Date.now() + result.expires_in * 1000 : null,
    });
    if (!fs.existsSync(localKeyPath)) {
      fs.writeFileSync(localKeyPath, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
    }
    console.log(`Authenticated ${user.login}; Copilot entitlement verified.`);
    console.log(`Approved inference origin: ${endpoint.origin}`);
    return;
  }
  throw new Error("Device authorization expired; rerun authenticate.mjs");
}

authenticate().catch(error => {
  console.error(`Authentication failed: ${error.message}`);
  process.exitCode = 1;
});
