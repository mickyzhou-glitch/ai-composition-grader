// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { ensurePrintTokenSecret } from "./print-token-secret";

describe("ensurePrintTokenSecret", () => {
  it("沿用已有的合规密钥，不重复写入钥匙串", async () => {
    const store = {
      get: vi.fn(async () => "existing-print-token-secret-at-least-32-characters"),
      set: vi.fn(),
    };

    await expect(ensurePrintTokenSecret(store)).resolves.toBe("existing-print-token-secret-at-least-32-characters");
    expect(store.set).not.toHaveBeenCalled();
  });

  it("在首次安装时生成并保存至少 32 字符的随机密钥", async () => {
    const store = { get: vi.fn(async () => null), set: vi.fn(async () => undefined) };

    const secret = await ensurePrintTokenSecret(store);

    expect(secret).toHaveLength(43);
    expect(store.set).toHaveBeenCalledWith(secret);
  });
});
