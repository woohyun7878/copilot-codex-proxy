# Copilot Codex Proxy

A dependency-free, authenticated, loopback-only proxy from OpenAI's native
Responses protocol to **GitHub Copilot**. It never uses a ChatGPT subscription
or an OpenAI API key. Requires Node.js 22.17+.

This is an unofficial integration, not supported by GitHub or OpenAI. Confirm
that your organization's policy permits it. Copilot model availability, premium
request multipliers, limits, and terms still apply. Do not send organizational
code until your organization approves this integration.

## Windows setup

1. Clone this repository into a user-private directory.
2. Authenticate the GitHub identity that has the intended Copilot entitlement:

   ```powershell
   node .\authenticate.mjs --login YOUR_GITHUB_LOGIN
   ```

   Complete device authorization at `https://github.com/login/device`. The
   script verifies the exact account and Copilot entitlement before saving
   credentials. It does not import credentials from other applications.

3. Configure the local key for Codex without displaying it:

   ```powershell
   $state = Join-Path $env:LOCALAPPDATA 'CopilotCodexProxy\state'
   $key = [IO.File]::ReadAllText((Join-Path $state 'local-api-key')).Trim()
   [Environment]::SetEnvironmentVariable('CODEX_COPILOT_PROXY_KEY', $key, 'User')
   $env:CODEX_COPILOT_PROXY_KEY = $key
   ```

4. Back up `~\.codex\config.toml` and set these provider fields, preserving other
   settings. Select a model actually returned by `/v1/models` that supports the
   Responses endpoint; there are no model aliases or protocol fallbacks.

   ```toml
   model_provider = "copilot-local"
   model = "YOUR_AVAILABLE_RESPONSES_MODEL"

   [model_providers.copilot-local]
   name = "GitHub Copilot (local)"
   base_url = "http://127.0.0.1:17688/v1"
   wire_api = "responses"
   env_key = "CODEX_COPILOT_PROXY_KEY"
   requires_openai_auth = false
   supports_websockets = false
   ```

5. Start the proxy:

   ```powershell
   .\start-proxy.ps1
   ```

6. Fully quit Codex Desktop before running `.\start-codex.ps1`. The launcher
   supplies the key to the new Desktop process. An existing Desktop process
   cannot inherit a newly configured environment variable.

No automatic startup, scheduled task, firewall rule, administrator elevation, or
machine-wide setting is installed.

For an already configured Windows installation, `.\connect-windows.ps1
-GitHubLogin YOUR_GITHUB_LOGIN` performs device authorization, sets the local key,
starts a visible proxy terminal, checks readiness, and launches Desktop. Fully
quit Desktop first. It does not write or replace your Codex configuration.

## Authentication and storage

State is outside this repository at
`%LOCALAPPDATA%\CopilotCodexProxy\state`. OAuth and refresh tokens are stored in
`github.json`; the separate local bearer key is in `local-api-key`.
Tokens are stored as files, not encrypted. **Restrict this directory and the
installation to your Windows account, SYSTEM, and Administrators.** The key also
exists in your user environment for Codex; applications running as you can read
it. Do not put these files, logs, or environment exports in a repository.

The OAuth client ID, form encoding, minimal `read:user` scope, refresh-token
handling, and Copilot headers follow the
[`ai.rs` Copilot OAuth implementation](https://github.com/prabirshrestha/ai.rs/blob/main/crates/ai/src/oauth/github_copilot.rs).
This package does not automatically enable models or accept their policies.
Only `github.com` identities are supported.

## Endpoints and privacy

Every endpoint requires `Authorization: Bearer <local-api-key>`, the exact
loopback Host header, and no browser Origin header.

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Local readiness; does not perform inference |
| `GET /v1/models` | Available models from Copilot |
| `POST /v1/responses` | Native Responses passthrough, including SSE |
| `GET /usage` | Copilot account/plan and quota snapshot from GitHub |

Inference goes only to HTTPS `*.githubcopilot.com` endpoints supplied by GitHub.
Authentication and usage lookups go only to `github.com` and `api.github.com`.
Redirects, wildcard browser access, and alternate-service fallbacks are disabled.
The proxy replaces client authorization with its own short-lived Copilot token;
it never forwards a Codex/ChatGPT credential. It does not install a DNS override.

Logs contain request IDs, route, model, Copilot origin, status, and timing, not
prompts, responses, tokens, or upstream error bodies. Protect logs nonetheless.
Requests are limited to 32 MiB and ten minutes of upstream execution.

## Verification

```powershell
$state = Join-Path $env:LOCALAPPDATA 'CopilotCodexProxy\state'
$key = [IO.File]::ReadAllText((Join-Path $state 'local-api-key')).Trim()
$headers = @{ Authorization = "Bearer $key" }
Invoke-RestMethod http://127.0.0.1:17688/health -Headers $headers
Invoke-RestMethod http://127.0.0.1:17688/v1/models -Headers $headers
Invoke-RestMethod http://127.0.0.1:17688/usage -Headers $headers
```

Use an empty directory and a synthetic prompt to test Codex. Correlate that turn
with a successful proxy log entry to a Copilot origin. Compare `/usage` before
and after, allowing for delayed accounting. Some included models have no premium
request delta. A successful proxy request proves the inference route, but only
GitHub's billing/usage records can establish final quota attribution. A CLI-only
test does not prove that the Desktop UI used the same route.

Custom providers apply to local inference. ChatGPT login, cloud tasks, plugins,
and other Desktop services are separate; this proxy does not reroute them.
Existing threads may retain their original provider, so start a new local chat.

Run offline tests with `npm test`; no dependency installation is needed.

## Attribution

Based on the Responses passthrough design of
[`lbx154/copilot-codex-proxy`](https://github.com/lbx154/copilot-codex-proxy)
at `e01a26e2a776243e9c3128640680a0255e136d06`, simplified to native Responses
only with dedicated authentication and a smaller exposed surface. The upstream
MIT license is preserved in `LICENSE`.
