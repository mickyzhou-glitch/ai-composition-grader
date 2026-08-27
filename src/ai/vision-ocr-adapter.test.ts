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

function page(pageIndex: number, text: string) {
  return {
    pageIndex,
    text,
    readable: true,
    warnings: [],
    blocks: [{ text, x: 0.1, y: 0.1, width: 0.8, height: 0.1 }],
  };
}

function paragraph(
  paragraphIndex = 0,
  text = "我终于明白了。",
  overrides: Record<string, unknown> = {},
) {
  return {
    paragraphIndex,
    text,
    segments: [{ pageIndex: 0, text, x: 0.2, y: 0.4, width: 0.3, height: 0.05 }],
    ...overrides,
  };
}

function validSinglePageResponse() {
  return {
    pages: [page(0, "我终于明白了。")],
    paragraphs: [paragraph()],
  };
}

async function expectInvalidResponse(response: unknown, imageCount = 1) {
  const harness = setup(response);

  await expect(harness.adapter.recognize({
    imageUrls: Array.from(
      { length: imageCount },
      (_, index) => `data:image/jpeg;base64,page-${index}`,
    ),
  })).rejects.toMatchObject({ code: "AI_INVALID_RESPONSE" });
}

describe("VisionOcrAdapter", () => {
  it("asks the vision model to return only composition paragraphs without review suggestions", async () => {
    const harness = setup(validSinglePageResponse());

    await harness.adapter.recognize({
      imageUrls: ["data:image/jpeg;base64,eA=="],
    });

    expect(harness.settings.getRuntimeConfig).toHaveBeenCalledWith("vision");
    const serialized = JSON.stringify(harness.create.mock.calls[0][0]);
    expect(serialized).toContain("data:image/jpeg;base64,eA==");
    expect(serialized).toContain("只把作文正文自然段写入 paragraphs");
    expect(serialized).toContain("跨页延续使用同一个 paragraphIndex");
    expect(serialized).not.toContain("修改建议");
  });

  it("returns pages and recognized paragraph regions for one page", async () => {
    const response = validSinglePageResponse();
    const harness = setup(response);

    await expect(harness.adapter.recognize({
      imageUrls: ["data:image/jpeg;base64,eA=="],
    })).resolves.toEqual(response);
  });

  it("returns one paragraph whose source regions continue across pages", async () => {
    const response = {
      pages: [page(0, "跨页段落的上半部"), page(1, "与下半部。")],
      paragraphs: [paragraph(0, "跨页段落的上半部与下半部。", {
        segments: [
          { pageIndex: 0, text: "跨页段落的上半部", x: 0.1, y: 0.86, width: 0.7, height: 0.08 },
          { pageIndex: 1, text: "与下半部。", x: 0.1, y: 0.04, width: 0.5, height: 0.08 },
        ],
      })],
    };
    const harness = setup(response);

    await expect(harness.adapter.recognize({
      imageUrls: ["data:image/jpeg;base64,page-0", "data:image/jpeg;base64,page-1"],
    })).resolves.toEqual(response);
  });

  it("rejects a response whose page count differs from the supplied images", async () => {
    await expectInvalidResponse({
      pages: [page(0, "第一页"), page(1, "第二页")],
      paragraphs: [paragraph()],
    });
  });

  it("rejects a response without recognized paragraphs", async () => {
    await expectInvalidResponse({ pages: [page(0, "无正文")], paragraphs: [] });
  });

  it("rejects discontinuous paragraph indexes", async () => {
    await expectInvalidResponse({
      pages: [page(0, "正文")],
      paragraphs: [paragraph(1, "正文")],
    });
  });

  it("rejects paragraph regions outside their page", async () => {
    await expectInvalidResponse({
      ...validSinglePageResponse(),
      paragraphs: [paragraph(0, "正文", {
        segments: [{ pageIndex: 0, text: "正文", x: 0.8, y: 0.4, width: 0.3, height: 0.05 }],
      })],
    });
  });

  it("rejects paragraph regions that reference a missing page", async () => {
    await expectInvalidResponse({
      ...validSinglePageResponse(),
      paragraphs: [paragraph(0, "正文", {
        segments: [{ pageIndex: 1, text: "正文", x: 0.2, y: 0.4, width: 0.3, height: 0.05 }],
      })],
    });
  });

  it("rejects paragraph text that differs from its normalized segment text", async () => {
    await expectInvalidResponse({
      ...validSinglePageResponse(),
      paragraphs: [paragraph(0, "模型篡改后的正文", {
        segments: [{ pageIndex: 0, text: "忠实转写的正文", x: 0.2, y: 0.4, width: 0.3, height: 0.05 }],
      })],
    });
  });

  it("rejects paragraph segments outside reading order", async () => {
    await expectInvalidResponse({
      ...validSinglePageResponse(),
      paragraphs: [paragraph(0, "后面前面", {
        segments: [
          { pageIndex: 0, text: "后面", x: 0.1, y: 0.7, width: 0.3, height: 0.05 },
          { pageIndex: 0, text: "前面", x: 0.1, y: 0.3, width: 0.3, height: 0.05 },
        ],
      })],
    });
  });

  it("rejects overlapping regions from different paragraphs on one page", async () => {
    await expectInvalidResponse({
      pages: [page(0, "第一段第二段")],
      paragraphs: [
        paragraph(0, "第一段", {
          segments: [{ pageIndex: 0, text: "第一段", x: 0.1, y: 0.2, width: 0.5, height: 0.1 }],
        }),
        paragraph(1, "第二段", {
          segments: [{ pageIndex: 0, text: "第二段", x: 0.5, y: 0.25, width: 0.4, height: 0.1 }],
        }),
      ],
    });
  });

  it("rejects model-provided paragraph ids at the response boundary", async () => {
    await expectInvalidResponse({
      ...validSinglePageResponse(),
      paragraphs: [{ ...paragraph(), id: "model-controlled-id" }],
    });
  });
});
