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
  it("忽略模型多出的元数据，缺省非正文 warnings 和 blocks", async () => {
    const response = validSinglePageResponse();
    const harness = setup({
      title: "模型附带标题",
      pages: [{ pageIndex: 0, text: response.pages[0].text, readable: true }],
      paragraphs: [{ ...response.paragraphs[0], confidence: 0.9 }],
    });
    const result = await harness.adapter.recognize({ imageUrls: ["image"] });
    expect(result.pages[0]).toMatchObject({ warnings: [], blocks: [] });
    expect(result.paragraphs).toEqual(response.paragraphs);
    expect(harness.create).toHaveBeenCalledTimes(1);
  });

  it("OCR 结构无效时带原图修复一次，再完整校验", async () => {
    const harness = setup(validSinglePageResponse());
    harness.create.mockResolvedValueOnce({ choices: [{ message: { content: '{"pages":[]}' } }] });
    await expect(harness.adapter.recognize({ imageUrls: ["original-image"] })).resolves.toEqual(validSinglePageResponse());
    expect(harness.create).toHaveBeenCalledTimes(2);
    const repair = JSON.stringify(harness.create.mock.calls[1][0]);
    expect(repair).toContain("original-image");
    expect(repair).toContain("ocr_schema_pages_too_small");
    expect(repair).toContain("待处理数据");
  });

  it.each([
    ["not json", "ocr_json_parse"],
    ["", "ocr_empty_content"],
    [JSON.stringify({ pages: [], paragraphs: [] }), "ocr_schema_pages_too_small"],
    [JSON.stringify({ pages: [page(0, "一"), page(1, "二")], paragraphs: [paragraph()] }), "ocr_page_count"],
  ])("修复仍失败时保留具体原因：%s", async (content, upstreamCode) => {
    const harness = setup({});
    harness.create.mockResolvedValue({ choices: [{ message: { content } }] });
    await expect(harness.adapter.recognize({ imageUrls: ["image"] })).rejects.toMatchObject({ code: "AI_INVALID_RESPONSE", upstreamCode });
    expect(harness.create).toHaveBeenCalledTimes(2);
  });

  it("即使 JSON 完整，finish_reason=length 也必须重新识别，不能保存半份正文", async () => {
    const harness = setup(validSinglePageResponse());
    harness.create.mockResolvedValue({ choices: [{ message: { content: JSON.stringify(validSinglePageResponse()) }, finish_reason: "length" }] } as never);
    await expect(harness.adapter.recognize({ imageUrls: ["image"] })).rejects.toMatchObject({ upstreamCode: "ocr_output_truncated" });
    expect(harness.create).toHaveBeenCalledTimes(2);
    expect(harness.create.mock.calls[1][0]).toMatchObject({ max_tokens: 8192 });
  });

  it("识别请求的 4xx 透传，不触发格式修复", async () => {
    const harness = setup({});
    harness.create.mockRejectedValueOnce(Object.assign(new Error("Forbidden"), { status: 403 }));
    await expect(harness.adapter.recognize({ imageUrls: ["image"] })).rejects.toMatchObject({ code: "AI_REQUEST_FAILED", upstreamStatus: 403 });
    expect(harness.create).toHaveBeenCalledTimes(1);
  });

  it("修复请求的 4xx 仍透传，不伪装成 OCR 格式错误", async () => {
    const harness = setup({});
    harness.create
      .mockResolvedValueOnce({ choices: [{ message: { content: "not json" } }] })
      .mockRejectedValueOnce(Object.assign(new Error("Forbidden"), { status: 403 }));
    await expect(harness.adapter.recognize({ imageUrls: ["image"] })).rejects.toMatchObject({ code: "AI_REQUEST_FAILED", upstreamStatus: 403 });
    expect(harness.create).toHaveBeenCalledTimes(2);
  });
  it("asks the vision model to return only composition paragraphs without review suggestions", async () => {
    const harness = setup(validSinglePageResponse());

    await harness.adapter.recognize({
      imageUrls: ["data:image/jpeg;base64,eA=="],
    });

    expect(harness.settings.getRuntimeConfig).toHaveBeenCalledWith("vision");
    const serialized = JSON.stringify(harness.create.mock.calls[0][0]);
    expect(serialized).toContain("data:image/jpeg;base64,eA==");
    expect(serialized).toContain("不要把作文图片裁成一段一段再识别");
    expect(serialized).toContain("只把作文正文自然段写入 paragraphs");
    expect(serialized).toContain("不得合并");
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

  it("原文有 5 个自然段而模型合并成 3 段时仍返回 5 段", async () => {
    const lines = ["第一段。", "第二段。", "第三段。", "第四段。", "第五段。"];
    const harness = setup({
      pages: [page(0, lines.join("\n"))],
      paragraphs: [
        paragraph(0, "第一段。第二段。"),
        paragraph(1, "第三段。"),
        paragraph(2, "第四段。第五段。"),
      ],
    });

    const recognized = await harness.adapter.recognize({
      imageUrls: ["data:image/jpeg;base64,eA=="],
    });

    expect(recognized.paragraphs.map((item) => item.text)).toEqual(lines);
    expect(recognized.paragraphs).toHaveLength(5);
    expect(recognized.pages).toHaveLength(1);
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

  it("忽略模型自定 ID，由 checkpoint 根据顺序生成稳定 ID", async () => {
    const harness = setup({
      ...validSinglePageResponse(),
      paragraphs: [{ ...paragraph(), id: "model-controlled-id" }],
    });
    await expect(harness.adapter.recognize({ imageUrls: ["image"] })).resolves.toEqual(validSinglePageResponse());
  });
});
