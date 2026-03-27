import { describe, it, expect, beforeEach, vi } from "vitest";
import { assertSafeCloneUrl, SsrfBlockedError } from "../../src/lib/ssrf.js";
import * as dns from "node:dns";

// Mock the DNS module
vi.mock("node:dns", () => ({
  promises: {
    resolve4: vi.fn(),
  },
}));

describe("assertSafeCloneUrl", () => {
  const mockResolve4 = vi.mocked(dns.promises.resolve4);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("invalid URLs", () => {
    it("throws error for invalid URL", async () => {
      await expect(assertSafeCloneUrl("not a url")).rejects.toThrow(
        /Invalid URL/
      );
    });

    it("throws error for URL with no hostname", async () => {
      await expect(assertSafeCloneUrl("http://")).rejects.toThrow(
        /Invalid URL/
      );
    });
  });

  describe("DNS resolution failures", () => {
    it("throws error when DNS resolution fails", async () => {
      mockResolve4.mockRejectedValue(new Error("ENOTFOUND"));

      await expect(
        assertSafeCloneUrl("https://example.com/repo.git")
      ).rejects.toThrow(/Failed to resolve hostname/);
    });

    it("includes hostname in error message", async () => {
      mockResolve4.mockRejectedValue(new Error("ENOTFOUND"));

      await expect(
        assertSafeCloneUrl("https://my-domain.example.com/repo.git")
      ).rejects.toThrow(/my-domain.example.com/);
    });
  });

  describe("allowed public IPs", () => {
    it("allows safe public IP", async () => {
      mockResolve4.mockResolvedValue(["1.1.1.1"]);

      const result = await assertSafeCloneUrl("https://example.com/repo.git");
      expect(result).toBe("https://example.com/repo.git");
    });

    it("allows another safe public IP", async () => {
      mockResolve4.mockResolvedValue(["8.8.8.8"]);

      const result = await assertSafeCloneUrl("https://github.com/user/repo.git");
      expect(result).toBe("https://github.com/user/repo.git");
    });

    it("allows URL with port", async () => {
      mockResolve4.mockResolvedValue(["44.55.66.77"]);

      const result = await assertSafeCloneUrl("https://example.com:8443/repo.git");
      expect(result).toBe("https://example.com:8443/repo.git");
    });

    it("allows multiple IPs if all are safe", async () => {
      mockResolve4.mockResolvedValue(["1.1.1.1", "8.8.8.8"]);

      const result = await assertSafeCloneUrl("https://example.com/repo.git");
      expect(result).toBe("https://example.com/repo.git");
    });
  });

  describe("RFC 1918 private ranges (10.0.0.0/8)", () => {
    it("blocks 10.0.0.0", async () => {
      mockResolve4.mockResolvedValue(["10.0.0.0"]);

      await expect(
        assertSafeCloneUrl("https://internal.example.com/repo.git")
      ).rejects.toThrow(/blocked IP address/);
    });

    it("blocks 10.255.255.255", async () => {
      mockResolve4.mockResolvedValue(["10.255.255.255"]);

      await expect(
        assertSafeCloneUrl("https://internal.example.com/repo.git")
      ).rejects.toThrow(/blocked IP address/);
    });

    it("blocks 10.50.100.200", async () => {
      mockResolve4.mockResolvedValue(["10.50.100.200"]);

      await expect(
        assertSafeCloneUrl("https://internal.example.com/repo.git")
      ).rejects.toThrow(/blocked IP address/);
    });

    it("throws SsrfBlockedError with code PRIVATE_RFC1918_10", async () => {
      mockResolve4.mockResolvedValue(["10.0.0.1"]);

      try {
        await assertSafeCloneUrl("https://internal.example.com/repo.git");
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(SsrfBlockedError);
        expect((error as SsrfBlockedError).code).toBe("PRIVATE_RFC1918_10");
        expect((error as SsrfBlockedError).ip).toBe("10.0.0.1");
        expect((error as SsrfBlockedError).hostname).toBe(
          "internal.example.com"
        );
      }
    });
  });

  describe("RFC 1918 private ranges (172.16.0.0/12)", () => {
    it("blocks 172.16.0.0", async () => {
      mockResolve4.mockResolvedValue(["172.16.0.0"]);

      await expect(
        assertSafeCloneUrl("https://internal.example.com/repo.git")
      ).rejects.toThrow(/blocked IP address/);
    });

    it("blocks 172.31.255.255", async () => {
      mockResolve4.mockResolvedValue(["172.31.255.255"]);

      await expect(
        assertSafeCloneUrl("https://internal.example.com/repo.git")
      ).rejects.toThrow(/blocked IP address/);
    });

    it("blocks 172.20.50.100", async () => {
      mockResolve4.mockResolvedValue(["172.20.50.100"]);

      await expect(
        assertSafeCloneUrl("https://internal.example.com/repo.git")
      ).rejects.toThrow(/blocked IP address/);
    });

    it("throws SsrfBlockedError with code PRIVATE_RFC1918_172", async () => {
      mockResolve4.mockResolvedValue(["172.20.0.1"]);

      try {
        await assertSafeCloneUrl("https://internal.example.com/repo.git");
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(SsrfBlockedError);
        expect((error as SsrfBlockedError).code).toBe("PRIVATE_RFC1918_172");
      }
    });

    it("allows 172.15.255.255 (just outside range)", async () => {
      mockResolve4.mockResolvedValue(["172.15.255.255"]);

      const result = await assertSafeCloneUrl("https://example.com/repo.git");
      expect(result).toBe("https://example.com/repo.git");
    });

    it("allows 172.32.0.0 (just outside range)", async () => {
      mockResolve4.mockResolvedValue(["172.32.0.0"]);

      const result = await assertSafeCloneUrl("https://example.com/repo.git");
      expect(result).toBe("https://example.com/repo.git");
    });
  });

  describe("RFC 1918 private ranges (192.168.0.0/16)", () => {
    it("blocks 192.168.0.0", async () => {
      mockResolve4.mockResolvedValue(["192.168.0.0"]);

      await expect(
        assertSafeCloneUrl("https://internal.example.com/repo.git")
      ).rejects.toThrow(/blocked IP address/);
    });

    it("blocks 192.168.255.255", async () => {
      mockResolve4.mockResolvedValue(["192.168.255.255"]);

      await expect(
        assertSafeCloneUrl("https://internal.example.com/repo.git")
      ).rejects.toThrow(/blocked IP address/);
    });

    it("blocks 192.168.1.1", async () => {
      mockResolve4.mockResolvedValue(["192.168.1.1"]);

      await expect(
        assertSafeCloneUrl("https://internal.example.com/repo.git")
      ).rejects.toThrow(/blocked IP address/);
    });

    it("throws SsrfBlockedError with code PRIVATE_RFC1918_192", async () => {
      mockResolve4.mockResolvedValue(["192.168.100.50"]);

      try {
        await assertSafeCloneUrl("https://internal.example.com/repo.git");
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(SsrfBlockedError);
        expect((error as SsrfBlockedError).code).toBe("PRIVATE_RFC1918_192");
      }
    });

    it("allows 192.167.255.255 (just outside range)", async () => {
      mockResolve4.mockResolvedValue(["192.167.255.255"]);

      const result = await assertSafeCloneUrl("https://example.com/repo.git");
      expect(result).toBe("https://example.com/repo.git");
    });

    it("allows 192.169.0.0 (just outside range)", async () => {
      mockResolve4.mockResolvedValue(["192.169.0.0"]);

      const result = await assertSafeCloneUrl("https://example.com/repo.git");
      expect(result).toBe("https://example.com/repo.git");
    });
  });

  describe("loopback (127.0.0.0/8)", () => {
    it("blocks 127.0.0.1", async () => {
      mockResolve4.mockResolvedValue(["127.0.0.1"]);

      await expect(
        assertSafeCloneUrl("https://localhost/repo.git")
      ).rejects.toThrow(/blocked IP address/);
    });

    it("blocks 127.255.255.255", async () => {
      mockResolve4.mockResolvedValue(["127.255.255.255"]);

      await expect(
        assertSafeCloneUrl("https://localhost/repo.git")
      ).rejects.toThrow(/blocked IP address/);
    });

    it("blocks 127.0.0.0", async () => {
      mockResolve4.mockResolvedValue(["127.0.0.0"]);

      await expect(
        assertSafeCloneUrl("https://localhost/repo.git")
      ).rejects.toThrow(/blocked IP address/);
    });

    it("throws SsrfBlockedError with code LOOPBACK", async () => {
      mockResolve4.mockResolvedValue(["127.0.0.1"]);

      try {
        await assertSafeCloneUrl("https://localhost/repo.git");
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(SsrfBlockedError);
        expect((error as SsrfBlockedError).code).toBe("LOOPBACK");
      }
    });
  });

  describe("link-local and metadata (169.254.0.0/16)", () => {
    it("blocks 169.254.0.0", async () => {
      mockResolve4.mockResolvedValue(["169.254.0.0"]);

      await expect(
        assertSafeCloneUrl("https://internal.example.com/repo.git")
      ).rejects.toThrow(/blocked IP address/);
    });

    it("blocks 169.254.169.254 (AWS metadata endpoint)", async () => {
      mockResolve4.mockResolvedValue(["169.254.169.254"]);

      await expect(
        assertSafeCloneUrl("https://metadata.example.com/repo.git")
      ).rejects.toThrow(/blocked IP address/);
    });

    it("blocks 169.254.255.255", async () => {
      mockResolve4.mockResolvedValue(["169.254.255.255"]);

      await expect(
        assertSafeCloneUrl("https://internal.example.com/repo.git")
      ).rejects.toThrow(/blocked IP address/);
    });

    it("throws SsrfBlockedError with code LINK_LOCAL_METADATA", async () => {
      mockResolve4.mockResolvedValue(["169.254.169.254"]);

      try {
        await assertSafeCloneUrl("https://metadata.example.com/repo.git");
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(SsrfBlockedError);
        expect((error as SsrfBlockedError).code).toBe("LINK_LOCAL_METADATA");
      }
    });

    it("allows 169.253.255.255 (just outside range)", async () => {
      mockResolve4.mockResolvedValue(["169.253.255.255"]);

      const result = await assertSafeCloneUrl("https://example.com/repo.git");
      expect(result).toBe("https://example.com/repo.git");
    });

    it("allows 169.255.0.0 (just outside range)", async () => {
      mockResolve4.mockResolvedValue(["169.255.0.0"]);

      const result = await assertSafeCloneUrl("https://example.com/repo.git");
      expect(result).toBe("https://example.com/repo.git");
    });
  });

  describe("blocks if any IP is blocked", () => {
    it("blocks if first IP is safe but second is blocked", async () => {
      mockResolve4.mockResolvedValue(["1.1.1.1", "192.168.1.1"]);

      await expect(
        assertSafeCloneUrl("https://example.com/repo.git")
      ).rejects.toThrow(/blocked IP address/);
    });

    it("blocks if first IP is blocked (stops at first blocked)", async () => {
      mockResolve4.mockResolvedValue(["127.0.0.1", "1.1.1.1"]);

      await expect(
        assertSafeCloneUrl("https://example.com/repo.git")
      ).rejects.toThrow(/blocked IP address/);
    });
  });
});
