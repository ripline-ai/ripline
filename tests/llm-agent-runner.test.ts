import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLlmAgentRunner,
  type LlmAgentRunnerConfig,
} from "../src/llm-agent-runner.js";
import { collectAgentResult } from "../src/pipeline/executors/agent.js";
import type { AgentRunner, AgentRunParams } from "../src/pipeline/executors/agent.js";

/** Run and collect result from any AgentRunner. */
async function run(runner: AgentRunner, params: AgentRunParams, signal?: AbortSignal) {
  return collectAgentResult(runner.run(params, signal));
}

describe("createLlmAgentRunner", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Ollama", () => {
    it("POSTs to baseURL/api/chat with model and messages, returns text from message.content", async () => {
      let capturedUrl: string | undefined;
      let capturedInit: RequestInit | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string, init?: RequestInit) => {
          capturedUrl = url;
          capturedInit = init;
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                message: { content: "Ollama reply" },
              }),
          } as Response);
        })
      );

      const config: LlmAgentRunnerConfig = {
        provider: "ollama",
        model: "llama3.2",
        baseURL: "http://localhost:11434",
      };
      const runner = createLlmAgentRunner(config);
      const result = await run(runner, {
        agentId: "default",
        prompt: "Hello",
      });

      expect(capturedUrl).toBe("http://localhost:11434/api/chat");
      expect(capturedInit?.method).toBe("POST");
      const body = JSON.parse((capturedInit?.body as string) ?? "{}");
      expect(body.model).toBe("llama3.2");
      expect(body.messages).toEqual([{ role: "user", content: "Hello" }]);
      expect(body.stream).toBe(false);
      expect(result.text).toBe("Ollama reply");
    });

    it("uses default baseURL http://localhost:11434 when baseURL omitted", async () => {
      let capturedUrl: string | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string) => {
          capturedUrl = url;
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({ message: { content: "ok" } }),
          } as Response);
        })
      );

      const runner = createLlmAgentRunner({
        provider: "ollama",
        model: "llama3.2",
      });
      await run(runner, { agentId: "default", prompt: "Hi" });

      expect(capturedUrl).toBe("http://localhost:11434/api/chat");
    });

    it("extracts text from message.content when it is an array of parts", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                message: {
                  content: [{ type: "text", text: "Part one. Part two." }],
                },
              }),
          } as Response)
        )
      );

      const runner = createLlmAgentRunner({
        provider: "ollama",
        model: "llama3.2",
      });
      const result = await run(runner, { agentId: "default", prompt: "Hi" });

      expect(result.text).toBe("Part one. Part two.");
    });
  });

  describe("OpenAI", () => {
    it("POSTs to baseURL/v1/chat/completions with Authorization Bearer, returns choices[0].message.content and usage", async () => {
      let capturedUrl: string | undefined;
      let capturedInit: RequestInit | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string, init?: RequestInit) => {
          capturedUrl = url;
          capturedInit = init;
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                choices: [
                  { message: { content: "OpenAI reply" } },
                ],
                usage: { prompt_tokens: 10, completion_tokens: 5 },
              }),
          } as Response);
        })
      );

      const runner = createLlmAgentRunner({
        provider: "openai",
        model: "gpt-4o-mini",
        apiKey: "sk-test",
        baseURL: "https://api.openai.com/v1",
      });
      const result = await run(runner, {
        agentId: "default",
        prompt: "Summarize",
      });

      expect(capturedUrl).toBe("https://api.openai.com/v1/chat/completions");
      expect((capturedInit?.headers as Record<string, string>)?.["Authorization"]).toBe(
        "Bearer sk-test"
      );
      const body = JSON.parse((capturedInit?.body as string) ?? "{}");
      expect(body.model).toBe("gpt-4o-mini");
      expect(body.messages).toEqual([{ role: "user", content: "Summarize" }]);
      expect(result.text).toBe("OpenAI reply");
      expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    });

    it("uses default baseURL https://api.openai.com/v1 when baseURL omitted", async () => {
      let capturedUrl: string | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string) => {
          capturedUrl = url;
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                choices: [{ message: { content: "ok" } }],
              }),
          } as Response);
        })
      );

      const runner = createLlmAgentRunner({
        provider: "openai",
        model: "gpt-4o",
        apiKey: "sk-x",
      });
      await run(runner, { agentId: "default", prompt: "Hi" });

      expect(capturedUrl).toBe("https://api.openai.com/v1/chat/completions");
    });
  });

  describe("Anthropic", () => {
    it("POSTs to messages API with x-api-key and anthropic-version, returns content[0].text and usage", async () => {
      let capturedUrl: string | undefined;
      let capturedInit: RequestInit | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string, init?: RequestInit) => {
          capturedUrl = url;
          capturedInit = init;
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                content: [{ type: "text", text: "Anthropic reply" }],
                usage: { input_tokens: 20, output_tokens: 8 },
              }),
          } as Response);
        })
      );

      const runner = createLlmAgentRunner({
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
        apiKey: "sk-ant-test",
      });
      const result = await run(runner, {
        agentId: "default",
        prompt: "Explain",
      });

      expect(capturedUrl).toBe("https://api.anthropic.com/v1/messages");
      const headers = capturedInit?.headers as Record<string, string>;
      expect(headers?.["x-api-key"]).toBe("sk-ant-test");
      expect(headers?.["anthropic-version"]).toBeDefined();
      expect(headers?.["anthropic-beta"]).toBe("prompt-caching-2024-07-31");
      const body = JSON.parse((capturedInit?.body as string) ?? "{}");
      expect(body.model).toBe("claude-3-5-sonnet-20241022");
      expect(body.messages).toEqual([
        {
          role: "user",
          content: [
            { type: "text", text: "Explain", cache_control: { type: "ephemeral" } },
          ],
        },
      ]);
      expect(body.system).toBeUndefined();
      expect(body.max_tokens).toBeDefined();
      expect(result.text).toBe("Anthropic reply");
      expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 8 });
    });

    it("splits prompt on --- separator into system + user with cache_control on both", async () => {
      let capturedInit: RequestInit | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn((_url: string, init?: RequestInit) => {
          capturedInit = init;
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                content: [{ type: "text", text: "ok" }],
                usage: { input_tokens: 5, output_tokens: 2 },
              }),
          } as Response);
        })
      );

      const runner = createLlmAgentRunner({
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
        apiKey: "sk-ant-test",
      });
      await runner({
        agentId: "default",
        prompt: "You are a helpful assistant.\n---\nWhat is 2+2?",
      });

      const body = JSON.parse((capturedInit?.body as string) ?? "{}");
      expect(body.system).toEqual([
        {
          type: "text",
          text: "You are a helpful assistant.",
          cache_control: { type: "ephemeral" },
        },
      ]);
      expect(body.messages).toEqual([
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "What is 2+2?",
              cache_control: { type: "ephemeral" },
            },
          ],
        },
      ]);
    });
  });

  describe("timeout", () => {
    it("passes AbortSignal with timeoutSeconds to fetch", async () => {
      let capturedSignal: AbortSignal | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn((_url: string, init?: RequestInit) => {
          capturedSignal = init?.signal as AbortSignal;
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                choices: [{ message: { content: "ok" } }],
              }),
          } as Response);
        })
      );

      const runner = createLlmAgentRunner({
        provider: "openai",
        model: "gpt-4o",
        apiKey: "sk-x",
      });
      await run(runner, {
        agentId: "default",
        prompt: "Hi",
        timeoutSeconds: 30,
      });

      expect(capturedSignal).toBeDefined();
      expect(capturedSignal?.aborted).toBe(false);
    });
  });

  describe("errors", () => {
    it("throws with clear message when response is not ok", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve({
            ok: false,
            status: 429,
            statusText: "Too Many Requests",
            text: () => Promise.resolve("Rate limited"),
          } as Response)
        )
      );

      const runner = createLlmAgentRunner({
        provider: "openai",
        model: "gpt-4o",
        apiKey: "sk-x",
      });

      await expect(
        run(runner, { agentId: "default", prompt: "Hi" })
      ).rejects.toThrow(/429|Too Many Requests|Rate limited|failed/i);
    });

    it("throws when response JSON has no extractable text", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve({
            ok: true,
            json: () => Promise.resolve({}),
          } as Response)
        )
      );

      const runner = createLlmAgentRunner({
        provider: "ollama",
        model: "llama3.2",
      });

      await expect(
        run(runner, { agentId: "default", prompt: "Hi" })
      ).rejects.toThrow(/text|extract|response/i);
    });
  });
});
