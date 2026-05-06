import type { AgentRunner, AgentRunParams, AgentEvent, TokenUsage } from "./pipeline/executors/agent.js";

export type LlmAgentRunnerConfig = {
  provider: "ollama" | "openai" | "anthropic";
  model: string;
  apiKey?: string;
  baseURL?: string;
};

const OLLAMA_DEFAULT_BASE = "http://localhost:11434";
const OPENAI_DEFAULT_BASE = "https://api.openai.com/v1";
const ANTHROPIC_DEFAULT_BASE = "https://api.anthropic.com/v1";

function extractOllamaText(data: {
  message?: { content?: string | Array<{ type?: string; text?: string }> };
}): string {
  const content = data.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .filter((p) => p?.type === "text" && typeof p.text === "string")
      .map((p) => (p as { text: string }).text);
    return parts.join("");
  }
  throw new Error("Could not extract text from Ollama response");
}

function extractOpenAIText(data: {
  choices?: Array<{ message?: { content?: string } }>;
}): string {
  const text = data.choices?.[0]?.message?.content;
  if (typeof text === "string") return text;
  throw new Error("Could not extract text from OpenAI response");
}

function extractAnthropicText(data: {
  content?: Array<{ type?: string; text?: string }>;
}): string {
  const first = data.content?.[0];
  if (first?.type === "text" && typeof first.text === "string")
    return first.text;
  throw new Error("Could not extract text from Anthropic response");
}

/**
 * Create an AgentRunner that calls Ollama, OpenAI, or Anthropic APIs.
 * Use when running standalone without an external agent runner. Single model for all agent nodes.
 */
export function createLlmAgentRunner(config: LlmAgentRunnerConfig): AgentRunner {
  const { provider, model, apiKey, baseURL } = config;

  async function* runImpl(params: AgentRunParams): AsyncGenerator<AgentEvent> {
    const timeoutMs =
      params.timeoutSeconds !== undefined
        ? params.timeoutSeconds * 1000
        : 300_000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      if (provider === "ollama") {
        const base = baseURL ?? OLLAMA_DEFAULT_BASE;
        const url = `${base.replace(/\/$/, "")}/api/chat`;
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: params.prompt }],
            stream: false,
          }),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        if (!res.ok) {
          const body = await res.text();
          throw new Error(
            `Ollama request failed: ${res.status} ${res.statusText}${body ? ` - ${body.slice(0, 200)}` : ""}`
          );
        }
        const data = (await res.json()) as unknown;
        const text = extractOllamaText(
          data as Parameters<typeof extractOllamaText>[0]
        );
        yield { type: "message_done", text } satisfies AgentEvent;
        return;
      }

      if (provider === "openai") {
        const base = baseURL ?? OPENAI_DEFAULT_BASE;
        const url = `${base.replace(/\/$/, "")}/chat/completions`;
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
        const res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: params.prompt }],
          }),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        if (!res.ok) {
          const body = await res.text();
          throw new Error(
            `OpenAI request failed: ${res.status} ${res.statusText}${body ? ` - ${body.slice(0, 200)}` : ""}`
          );
        }
        const data = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const text = extractOpenAIText(data);
        const usage: TokenUsage = {};
        if (
          data.usage &&
          typeof data.usage.prompt_tokens === "number" &&
          typeof data.usage.completion_tokens === "number"
        ) {
          usage.inputTokens = data.usage.prompt_tokens;
          usage.outputTokens = data.usage.completion_tokens;
        }
        yield {
          type: "message_done",
          text,
          ...(Object.keys(usage).length > 0 && { usage }),
        } satisfies AgentEvent;
        return;
      }

      if (provider === "anthropic") {
        const base = baseURL ?? ANTHROPIC_DEFAULT_BASE;
        const url = `${base.replace(/\/$/, "")}/messages`;
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "prompt-caching-2024-07-31",
        };
        if (apiKey) headers["x-api-key"] = apiKey;

        const separatorIndex = params.prompt.split("\n").findIndex((line) => line === "---");
        let systemParam:
          | Array<{ type: "text"; text: string; cache_control: { type: "ephemeral" } }>
          | undefined;
        let userText: string;

        if (separatorIndex !== -1) {
          const lines = params.prompt.split("\n");
          const systemText = lines.slice(0, separatorIndex).join("\n");
          userText = lines.slice(separatorIndex + 1).join("\n");
          systemParam = [
            { type: "text", text: systemText, cache_control: { type: "ephemeral" } },
          ];
        } else {
          userText = params.prompt;
        }

        const requestBody: Record<string, unknown> = {
          model,
          max_tokens: 4096,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: userText, cache_control: { type: "ephemeral" } },
              ],
            },
          ],
        };
        if (systemParam !== undefined) {
          requestBody["system"] = systemParam;
        }

        const res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        if (!res.ok) {
          const body = await res.text();
          throw new Error(
            `Anthropic request failed: ${res.status} ${res.statusText}${body ? ` - ${body.slice(0, 200)}` : ""}`
          );
        }
        const data = (await res.json()) as {
          content?: Array<{ type?: string; text?: string }>;
          usage?: { input_tokens?: number; output_tokens?: number };
        };
        const text = extractAnthropicText(data);
        const usage: TokenUsage = {};
        if (
          data.usage &&
          typeof data.usage.input_tokens === "number" &&
          typeof data.usage.output_tokens === "number"
        ) {
          usage.inputTokens = data.usage.input_tokens;
          usage.outputTokens = data.usage.output_tokens;
        }
        yield {
          type: "message_done",
          text,
          ...(Object.keys(usage).length > 0 && { usage }),
        } satisfies AgentEvent;
        return;
      }

      throw new Error(`Unsupported LLM provider: ${provider}`);
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof Error) throw err;
      throw new Error(String(err));
    }
  }

  return {
    run(params: AgentRunParams): AsyncGenerator<AgentEvent> {
      return runImpl(params);
    },
  };
}
