// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import type { OpenAIClientFactory, OpenAICompatibleClient } from "./openai-review-adapter";
import { VisionOcrAdapter } from "./vision-ocr-adapter";

function setup(response: unknown) {
  const create = vi.fn(async (input: unknown) => {
    void input;
    return {
      choices: [{ message: { content: JSON.stringify(response) } }],
    };
  });
  const factory = vi.fn((options: Parameters<OpenAIClientFactory>[0]): OpenAICompatibleClient => {
    void options;
    return { chat: { completions: { create } } };
  });
  const settings = {
    getRuntimeConfig: vi.fn(async () => ({
      baseUrl: "https://vision.example/v1",
      model: "vision-model",
      apiKey: "vision-secret",
    })),
  };
  return { create, factory, settings, adapter: new VisionOcrAdapter(settings, { clientFactory: factory }) };
}

describe("VisionOcrAdapter", () => {
  it("uses the vision role and returns page text with normalized blocks", async () => {
    const harness = setup({
      pages: [{
        pageIndex: 0,
        text: "我终于明白了。",
        readable: true,
        warnings: [],
        blocks: [{ text: "我终于明白了。", x: 0.2, y: 0.4, width: 0.3, height: 0.05 }],
      }],
    });

    await expect(harness.adapter.recognize({
      imageUrls: ["data:image/jpeg;base64,eA=="],
    })).resolves.toMatchObject({ pages: [{ pageIndex: 0, text: "我终于明白了。" }] });
    expect(harness.settings.getRuntimeConfig).toHaveBeenCalledWith("vision");
    const serialized = JSON.stringify(harness.create.mock.calls[0][0]);
    expect(serialized).toContain("data:image/jpeg;base64,eA==");
    expect(serialized).toContain("blocks");
    expect(serialized).not.toContain("作文等级");
    expect(serialized).not.toContain("家长反馈");
  });

  it("rejects a response whose page count differs from the supplied images", async () => {
    const harness = setup({ pages: [] });

    await expect(harness.adapter.recognize({
      imageUrls: ["data:image/jpeg;base64,eA=="],
    })).rejects.toMatchObject({ code: "AI_INVALID_RESPONSE" });
  });
});
