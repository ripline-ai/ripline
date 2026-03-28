/**
 * Telegram notification helper.
 *
 * Sends messages via the Telegram Bot API (`sendMessage` endpoint).
 * Gracefully degrades: logs a warning and never throws if credentials
 * are missing or if the API call fails.
 */

import { createLogger } from "./log.js";
import type { TelegramConfig } from "./types.js";

const log = createLogger();

export type TelegramEvent =
  | { type: "run_started"; pipelineName: string; queueItemId: string }
  | { type: "run_completed"; pipelineName: string; queueItemId: string; summary?: string }
  | { type: "run_failed"; pipelineName: string; queueItemId: string; error?: string };

function formatMessage(event: TelegramEvent): string {
  switch (event.type) {
    case "run_started":
      return `⏳ *Background run started*\nPipeline: \`${event.pipelineName}\`\nQueue item: \`${event.queueItemId}\``;
    case "run_completed":
      return (
        `✅ *Background run completed*\nPipeline: \`${event.pipelineName}\`\nQueue item: \`${event.queueItemId}\`` +
        (event.summary ? `\nSummary: ${event.summary}` : "")
      );
    case "run_failed":
      return (
        `❌ *Background run failed*\nPipeline: \`${event.pipelineName}\`\nQueue item: \`${event.queueItemId}\`` +
        (event.error ? `\nError: ${event.error}` : "")
      );
  }
}

export class TelegramNotifier {
  private botToken: string | undefined;
  private chatId: string | undefined;

  constructor(config?: TelegramConfig) {
    this.botToken = config?.botToken;
    this.chatId = config?.chatId;
  }

  /**
   * Send a notification for a background-queue event.
   * Returns `true` if the message was sent successfully, `false` otherwise.
   * Never throws.
   */
  async notify(event: TelegramEvent): Promise<boolean> {
    if (!this.botToken || !this.chatId) {
      log.log("warn", "Telegram notification skipped: botToken or chatId not configured");
      return false;
    }

    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    const body = JSON.stringify({
      chat_id: this.chatId,
      text: formatMessage(event),
      parse_mode: "Markdown",
    });

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "<unreadable>");
        log.log("warn", `Telegram API returned ${res.status}: ${text}`);
        return false;
      }

      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.log("warn", `Telegram API call failed: ${msg}`);
      return false;
    }
  }
}

/** Convenience: build a notifier from optional config (returns a no-op-safe instance). */
export function createTelegramNotifier(config?: TelegramConfig): TelegramNotifier {
  return new TelegramNotifier(config);
}
