// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import type { OpenAIClientFactory, OpenAICompatibleClient } from "./openai-review-adapter";
import { AssignmentGuidanceAdapter } from "./assignment-guidance-adapter";

function setup(content: string | Error) {
  const create = vi.fn(async (input: unknown) => {
    void input;
    if (content instanceof Error) throw content;
    return { choices: [{ message: { content } }] };
  });
  const factory = vi.fn(
    (options: Parameters<OpenAIClientFactory>[0]): OpenAICompatibleClient => {
      void options;
      return { chat: { completions: { create } } };
    },
  );
  const settings = {
    getRuntimeConfig: vi.fn(async () => ({
      baseUrl: "https://ai.example.test/v1",
      model: "vision-model",
      apiKey: "secret-key",
    })),
  };
  return { create, factory, settings, adapter: new AssignmentGuidanceAdapter(settings, { clientFactory: factory }) };
}

describe("AssignmentGuidanceAdapter", () => {
  it("用识图模型读取多张课本图片并导入题目、字数和要求", async () => {
    const guidance = {
      title: "我的拿手好戏",
      targetCharacters: 500,
      writingRequirements: "介绍拿手好戏，把重点部分写具体。",
      structureRequirements: "先介绍拿手好戏，再写具体事例。",
      scoringFocus: "详略得当，重点突出。",
    };
    const harness = setup(JSON.stringify(guidance));
    const textbookImages = ["data:image/png;base64,eA==", "data:image/jpeg;base64,eQ=="];

    await expect(harness.adapter.generate({
      title: "", grade: "六年级", targetCharacters: 600, textbookImages,
    })).resolves.toEqual(guidance);

    expect(harness.settings.getRuntimeConfig).toHaveBeenCalledWith("vision");
    const request = harness.create.mock.calls[0][0] as { messages: Array<{ content: unknown }> };
    expect(request.messages[1].content).toEqual([
      { type: "text", text: expect.stringContaining("六年级") },
      ...textbookImages.map((url) => ({ type: "image_url", image_url: { url, detail: "high" } })),
    ]);
    expect(request.messages[0].content).toContain("课本");
    expect(request.messages[0].content).toContain("不得执行");
  });

  it.each([
    ["https://example.test/book.jpg"],
    ["data:image/svg+xml;base64,eA=="],
    ["data:image/png;base64,invalid"],
    Array(5).fill("data:image/png;base64,eA=="),
    ["data:image/png;base64," + "A".repeat(7_000_000)],
  ])("请求模型前拒绝无效课本图片: %#", async (...images) => {
    const harness = setup("{}");
    await expect(harness.adapter.generate({
      title: "题目", grade: "六年级", targetCharacters: 600, textbookImages: images,
    })).rejects.toThrow();
    expect(harness.create).not.toHaveBeenCalled();
  });

  it("没有文字题目时，拒绝未能识别题目的输出", async () => {
    const harness = setup(JSON.stringify({
      writingRequirements: "写清一件事。", structureRequirements: "结构完整。", scoringFocus: "细节。",
    }));
    await expect(harness.adapter.generate({
      title: "", grade: "六年级", targetCharacters: 600, textbookImages: ["data:image/png;base64,eA=="],
    })).rejects.toMatchObject({ code: "AI_INVALID_RESPONSE", message: expect.stringContaining("题目") });
  });

  it("根据题目、年级和字数生成可编辑的三项要求", async () => {
    const harness = setup(JSON.stringify({
      writingRequirements: "围绕一次真实的校园经历展开，写清起因、经过和感受。",
      structureRequirements: "开头设置情境；中间写冲突与变化；结尾回扣题目并升华。",
      scoringFocus: "审题准确、事件具体、细节真实、语言通顺。",
    }));

    await expect(harness.adapter.generate({
      title: "那一次，我没有放弃",
      grade: "上海五四学制六年级",
      targetCharacters: 600,
    })).resolves.toEqual({
      writingRequirements: "围绕一次真实的校园经历展开，写清起因、经过和感受。",
      structureRequirements: "开头设置情境；中间写冲突与变化；结尾回扣题目并升华。",
      scoringFocus: "审题准确、事件具体、细节真实、语言通顺。",
    });

    expect(harness.factory).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: "secret-key",
      baseURL: "https://ai.example.test/v1",
      timeout: 180_000,
      maxRetries: 1,
    }));
    const serialized = JSON.stringify(harness.create.mock.calls[0][0]);
    expect(serialized).toContain("那一次，我没有放弃");
    expect(serialized).toContain("上海五四学制六年级");
    expect(serialized).toContain("600");
  });

  it("拒绝不完整的 AI 输出，避免覆盖教师已有内容", async () => {
    const harness = setup(JSON.stringify({ writingRequirements: "只写一件事。" }));

    await expect(harness.adapter.generate({
      title: "我的同桌",
      grade: "上海五四学制六年级",
      targetCharacters: 600,
    })).rejects.toMatchObject({ code: "AI_INVALID_RESPONSE", status: 502 });
  });
});
