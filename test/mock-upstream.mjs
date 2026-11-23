const accessToken = "test-github-access";
const sessionToken = "test-copilot-session";

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input);
  if (url.href === "https://api.github.com/copilot_internal/v2/token") {
    if (options.headers.Authorization !== `Bearer ${accessToken}`) {
      throw new Error("Unexpected GitHub credential");
    }
    return Response.json({
      token: sessionToken,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      endpoints: { api: "https://api.enterprise.githubcopilot.com" },
    });
  }
  if (url.href === "https://api.github.com/copilot_internal/user") {
    if (options.headers.Authorization !== `Bearer ${accessToken}`) {
      throw new Error("Unexpected GitHub usage credential");
    }
    return Response.json({ copilot_plan: "enterprise", quota_snapshots: { premium_interactions: { remaining: 100 } } });
  }
  if (url.origin !== "https://api.enterprise.githubcopilot.com") {
    throw new Error("Attempted inference outside approved Copilot origin");
  }
  if (options.headers.Authorization !== `Bearer ${sessionToken}` || options.redirect !== "error") {
    throw new Error("Client credential leaked upstream or redirects enabled");
  }
  if (url.pathname === "/models") {
    return Response.json({ data: [{ id: "test-native-responses-model" }] });
  }
  if (url.pathname === "/v1/responses") {
    const body = JSON.parse(options.body);
    if (body.model === "unsupported-model") {
      return Response.json({ error: { message: "private-upstream-error" } }, { status: 400 });
    }
    if (body.model === "redirect-model") {
      return new Response(null, { status: 302, headers: { Location: "https://unverified.invalid" } });
    }
    const response = {
      id: "resp_test",
      object: "response",
      status: "completed",
      model: body.model,
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "SYNTHETIC_OK" }] }],
    };
    if (body.stream === false) return Response.json(response);
    return new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`, {
      headers: { "content-type": "text/event-stream", "x-github-request-id": "synthetic-request-id" },
    });
  }
  throw new Error("Unexpected upstream path");
};
