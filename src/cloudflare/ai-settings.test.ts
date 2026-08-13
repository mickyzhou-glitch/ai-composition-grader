import { describe, expect, it, vi } from "vitest";

import { configuredApiKey, createWorkerAiSettingsSource } from "./ai-settings";

describe("Cloudflare dual model settings", () => {
  it("uses the role secret before role env and legacy env", async () => {
    const open = vi.fn().mockResolvedValue("stored-secret");

    await expect(configuredApiKey({
      encryptedApiKey: "sealed",
      roleApiKey: "role-env",
      legacyApiKey: "legacy-env",
      encryptionKey: "proof-key",
      open,
    })).resolves.toBe("stored-secret");
    expect(open).toHaveBeenCalledWith("sealed", "proof-key");
  });

  it("falls back from the role env secret to the legacy secret", async () => {
    await expect(configuredApiKey({
      encryptedApiKey: null,
      roleApiKey: "content-env",
      legacyApiKey: "legacy-env",
      encryptionKey: "proof-key",
    })).resolves.toBe("content-env");
    await expect(configuredApiKey({
      encryptedApiKey: null,
      roleApiKey: undefined,
      legacyApiKey: "legacy-env",
      encryptionKey: "proof-key",
    })).resolves.toBe("legacy-env");
  });

  it("reads only the requested role configuration", async () => {
    const first = vi.fn().mockResolvedValue({
      base_url: "https://content.example/v1",
      model: "writer",
      encrypted_api_key: null,
    });
    const bind = vi.fn(() => ({ first }));
    const prepare = vi.fn(() => ({ bind }));
    const source = createWorkerAiSettingsSource({
      DB: { prepare } as unknown as D1Database,
      CONTENT_AI_API_KEY: "content-secret",
      AI_API_KEY: "legacy-secret",
      AUTH_PROOF_ENCRYPTION_KEY: "proof-key",
    });

    await expect(source.getRuntimeConfig("content")).resolves.toEqual({
      baseUrl: "https://content.example/v1",
      model: "writer",
      apiKey: "content-secret",
    });
    expect(bind).toHaveBeenCalledWith("content");
  });
});
