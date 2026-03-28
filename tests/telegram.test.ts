import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { TelegramNotifier, createTelegramNotifier } from "../src/telegram.js";
import type { TelegramEvent } from "../src/telegram.js";

describe("TelegramNotifier", () => {
  // ─── Story 4: Graceful degradation ─────────────────────

  describe("graceful degradation without credentials", () => {
    it("returns false and does not throw when botToken is missing", async () => {
      const notifier = new TelegramNotifier({ botToken: "", chatId: "123" });
      const result = await notifier.notify({
        type: "run_started",
        pipelineName: "test",
        queueItemId: "q1",
      });
      expect(result).toBe(false);
    });

    it("returns false and does not throw when chatId is missing", async () => {
      const notifier = new TelegramNotifier({ botToken: "tok", chatId: "" });
      const result = await notifier.notify({
        type: "run_started",
        pipelineName: "test",
        queueItemId: "q1",
      });
      expect(result).toBe(false);
    });

    it("returns false when constructed with no config", async () => {
      const notifier = new TelegramNotifier();
      const result = await notifier.notify({
        type: "run_completed",
        pipelineName: "p",
        queueItemId: "q",
      });
      expect(result).toBe(false);
    });
  });

  // ─── Story 4: Notification sends ───────────────────────

  describe("notification sending", () => {
    let fetchSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchSpy = vi.fn().mockResolvedValue({ ok: true, text: async () => "ok" });
      vi.stubGlobal("fetch", fetchSpy);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("sends run_started message with correct Telegram API URL", async () => {
      const notifier = new TelegramNotifier({ botToken: "BOT_TOKEN", chatId: "CHAT_ID" });
      const result = await notifier.notify({
        type: "run_started",
        pipelineName: "my-pipeline",
        queueItemId: "item-1",
      });
      expect(result).toBe(true);
      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://api.telegram.org/botBOT_TOKEN/sendMessage");
      expect(opts.method).toBe("POST");
      const body = JSON.parse(opts.body);
      expect(body.chat_id).toBe("CHAT_ID");
      expect(body.parse_mode).toBe("Markdown");
      expect(body.text).toContain("my-pipeline");
      expect(body.text).toContain("started");
    });

    it("sends run_completed message with optional summary", async () => {
      const notifier = new TelegramNotifier({ botToken: "tok", chatId: "cid" });
      await notifier.notify({
        type: "run_completed",
        pipelineName: "p",
        queueItemId: "q",
        summary: "All good!",
      });
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.text).toContain("completed");
      expect(body.text).toContain("All good!");
    });

    it("sends run_failed message with optional error", async () => {
      const notifier = new TelegramNotifier({ botToken: "tok", chatId: "cid" });
      await notifier.notify({
        type: "run_failed",
        pipelineName: "p",
        queueItemId: "q",
        error: "timeout",
      });
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.text).toContain("failed");
      expect(body.text).toContain("timeout");
    });

    it("returns false when Telegram API returns non-OK status", async () => {
      fetchSpy.mockResolvedValueOnce({ ok: false, status: 403, text: async () => "Forbidden" });
      const notifier = new TelegramNotifier({ botToken: "tok", chatId: "cid" });
      const result = await notifier.notify({
        type: "run_started",
        pipelineName: "p",
        queueItemId: "q",
      });
      expect(result).toBe(false);
    });

    it("returns false and never throws when fetch rejects", async () => {
      fetchSpy.mockRejectedValueOnce(new Error("Network error"));
      const notifier = new TelegramNotifier({ botToken: "tok", chatId: "cid" });
      const result = await notifier.notify({
        type: "run_started",
        pipelineName: "p",
        queueItemId: "q",
      });
      expect(result).toBe(false);
    });
  });

  // ─── Story 4: Factory function ─────────────────────────

  describe("createTelegramNotifier", () => {
    it("returns a TelegramNotifier instance", () => {
      const n = createTelegramNotifier({ botToken: "t", chatId: "c" });
      expect(n).toBeInstanceOf(TelegramNotifier);
    });

    it("returns a working instance when no config is provided", async () => {
      const n = createTelegramNotifier();
      // Should not throw
      const result = await n.notify({ type: "run_started", pipelineName: "p", queueItemId: "q" });
      expect(result).toBe(false);
    });
  });
});
