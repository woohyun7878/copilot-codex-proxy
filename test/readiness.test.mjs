import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const execute = promisify(execFile);
const helper = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "wait-proxy.ps1");
const runtimes = process.platform === "win32" ? ["powershell.exe", "pwsh.exe"] : [];

for (const runtime of runtimes) {
  let available = true;
  try {
    await execute(runtime, ["-NoProfile", "-NonInteractive", "-Command", "$null"]);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    available = false;
  }
  for (const unauthorized of [false, true]) {
    test(`${runtime}: ${unauthorized ? "authentication errors fail immediately" : "a timed-out health probe is retried"}`, { skip: !available }, async () => {
      let requests = 0;
      const server = http.createServer((req, res) => {
        requests++;
        if (unauthorized) {
          res.writeHead(401);
          res.end("Unauthorized");
          return;
        }
        const reply = () => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", provider: "github-copilot" }));
        };
        if (requests === 1) setTimeout(reply, 1500);
        else reply();
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const command = [
        "$ErrorActionPreference='Stop'",
        `. '${helper.replaceAll("'", "''")}'`,
        `$result = Wait-CopilotProxy -Headers @{Authorization='Bearer synthetic-readiness'} -Port ${server.address().port} -TimeoutSeconds 10 -ProbeTimeoutSeconds 1`,
        "Write-Output $result.provider",
      ].join("; ");
      try {
        const operation = execute(runtime, ["-NoProfile", "-NonInteractive", "-Command", command], { timeout: 20_000 });
        if (unauthorized) {
          await assert.rejects(operation, error => /401|Unauthorized/.test(error.stderr));
          assert.equal(requests, 1);
        } else {
          const result = await operation;
          assert.match(result.stdout, /github-copilot/);
          assert.equal(requests, 2);
        }
      } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    });
  }
}
