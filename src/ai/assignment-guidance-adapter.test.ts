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
