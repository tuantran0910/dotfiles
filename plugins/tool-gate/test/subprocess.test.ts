import { expect, it } from "bun:test";
import { classifyInSubprocess } from "../src/classifier.ts";
import { VERDICT_TOOL, parseVerdict } from "../src/verdict.ts";
import { gateHarness } from "./harness.ts";

/** Real Bun child + real pi-ai transport against a local canned provider. No
 * production credentials, model calls, proposed shell commands, or tools run. */
it("round-trips the forced verdict through the real subprocess and pi-ai", async () => {
  let request: any;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      request = await req.json();
      const chunk = (delta: unknown, finish_reason: string | null = null) => `data: ${JSON.stringify({ id: "test-completion", object: "chat.completion.chunk", created: 1, model: "test-judge", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      return new Response(
        chunk({ role: "assistant", tool_calls: [{ index: 0, id: "test-verdict", type: "function", function: { name: "verdict", arguments: JSON.stringify({ decision: "deny", reason: "synthetic integration verdict" }) } }] }) + chunk({}, "tool_calls") + "data: [DONE]\n\n",
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  const payload = {
    model: { id: "test-judge", name: "test-judge", api: "openai-completions", provider: "openai", baseUrl: `${server.url}v1`, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 512 },
    context: { systemPrompt: ["Synthetic test judge"], messages: [{ role: "user", content: "Synthetic pending call", timestamp: 1 }], tools: [VERDICT_TOOL] },
    options: { apiKey: "synthetic-test-key", maxTokens: 128, toolChoice: { type: "tool", name: "verdict" }, disableReasoning: true },
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const result = await classifyInSubprocess(payload, controller.signal, `${import.meta.dir}/..`);
    expect(parseVerdict(result)).toEqual({ action: "deny", reason: "synthetic integration verdict" });
    expect(request.tool_choice).toEqual({ type: "function", function: { name: "verdict" } });
    expect(request.tools[0].function.name).toBe("verdict");
  } finally {
    clearTimeout(timer);
    server.stop(true);
  }
}, 10000);

it("a real child with missing dependencies reports failure without a verdict", async () => {
  const h = gateHarness();
  await expect(classifyInSubprocess({ model: {}, context: {}, options: {} }, AbortSignal.timeout(3000), h.cwd)).rejects.toThrow();
});

it("an already cancelled subprocess request never starts", async () => {
  const controller = new AbortController();
  controller.abort();
  expect(await classifyInSubprocess({}, controller.signal, `${import.meta.dir}/..`)).toBeNull();
});

it("cancellation kills a real child waiting for its provider", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Promise<Response>(() => {}) });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300);
  const started = performance.now();
  try {
    await expect(classifyInSubprocess({
      model: { id: "test", name: "test", api: "openai-completions", provider: "openai", baseUrl: `${server.url}v1`, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 512 },
      context: { messages: [{ role: "user", content: "synthetic", timestamp: 1 }] },
      options: { apiKey: "synthetic-test-key", maxTokens: 128 },
    }, controller.signal, `${import.meta.dir}/..`)).rejects.toThrow();
    expect(controller.signal.aborted).toBe(true);
    expect(performance.now() - started).toBeLessThan(3000);
  } finally {
    clearTimeout(timer);
    server.stop(true);
  }
});
