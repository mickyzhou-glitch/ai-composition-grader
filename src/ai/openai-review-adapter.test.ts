// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import type { AssignmentConfig, EvaluationReport } from "../domain/contracts";
import {
  OpenAIReviewAdapter,
  testOpenAIConnection,
  type OpenAICompatibleClient,
  type OpenAIClientFactory,
} from "./openai-review-adapter";

const config: AssignmentConfig = {
  title: "为自己喝彩",
  grade: "上海五四学制六年级",
  writingRequirements: "写一件亲身经历的事。",
  targetCharacters: 600,
  structureRequirements: "开头点题，结尾升华。",
  scoringFocus: "细节描写。",
  templateType: "preset_self_applause",
};

const report: EvaluationReport = {
  themeFit: "fits",
  themeReason: "紧扣主题。",
  personalizedComment: "你的动作描写真实，继续保持。",
  painPoints: ["结尾略快"],
  commonIssues: ["长句较多"],
  revisionSuggestions: ["补充感受"],
  scores: {
    themeIntent: 9,
    contentSelection: 9,
    structure: 7,
    languageExpression: 7,
    writingConventions: 4,
    total: 36,
    level: "优秀作文",
  },
  sampleParagraphs: Array.from({ length: 5 }, () => "我".repeat(110)),
};

const successEnvelope = {
  readable: true,
  pageWarnings: [],
  report,
  annotations: [
    {
      pageIndex: 0,
      x: 0.2,
      y: 0.3,
      category: "sentence",
      anchorText: "我跑得很快",
      comment: "可以补充脚步和呼吸的细节。",
      isHighlight: false,
    },
  ],
};

function setup(contents: Array<string | null | Error>) {
  const create = vi.fn(async (input: unknown) => {
    void input;
    const next = contents.shift();
    if (next instanceof Error) throw next;
    return { choices: [{ message: { content: next ?? null } }] };
  });
  const factory = vi.fn(
    (options: Parameters<OpenAIClientFactory>[0]): OpenAICompatibleClient => {
      void options;
      return { chat: { completions: { create } } };
    },
  );
  const settings = {
    get: vi.fn(async () => ({
      baseUrl: "https://ai.example.test/v1",
      model: "vision-model",
      keyConfigured: true,
    })),
    getSecret: vi.fn(async () => "secret-key"),
  };
  return {
    create,
    factory,
    adapter: new OpenAIReviewAdapter(settings, { clientFactory: factory }),
  };
}

describe("OpenAIReviewAdapter", () => {
  it("用设置中的 endpoint/model/key、固定超时重试和全部 data URL 发起批改", async () => {
    const harness = setup([JSON.stringify(successEnvelope)]);
    const images = [
      "data:image/jpeg;base64,Zmlyc3Q=",
      "data:image/jpeg;base64,c2Vjb25k",
    ];

    const result = await harness.adapter.analyze({ config, imageDataUrls: images });

    expect(result).toEqual(successEnvelope);
    expect(harness.factory).toHaveBeenCalledWith({
      apiKey: "secret-key",
      baseURL: "https://ai.example.test/v1",
      timeout: 180_000,
      maxRetries: 1,
    });
    const request = harness.create.mock.calls[0][0] as {
      model: string;
      messages: unknown[];
    };
    expect(request.model).toBe("vision-model");
    const serialized = JSON.stringify(request.messages);
    expect(serialized).toContain(images[0]);
    expect(serialized).toContain(images[1]);
    expect(serialized).toContain(config.writingRequirements);
    expect(serialized).toContain("40");
    expect(serialized).toContain("themeIntent");
    expect(serialized).toContain("typo");
    expect(serialized).toContain("0..1");
    expect(serialized).toContain("不可猜测");
    expect(serialized).toContain("学生友好");
    expect(serialized).toContain("五段");
    expect(serialized).toContain("550-650");
  });

  it("兼容 ```json fenced JSON", async () => {
    const harness = setup([`\n\`\`\`json\n${JSON.stringify(successEnvelope)}\n\`\`\`\n`]);

    await expect(
      harness.adapter.analyze({ config, imageDataUrls: ["data:image/jpeg;base64,eA=="] }),
    ).resolves.toEqual(successEnvelope);
  });

  it("无法辨认时返回无 report 的信封", async () => {
    const unreadable = {
      readable: false,
      pageWarnings: ["第 1 页过暗，请在明亮环境下重拍。"],
      annotations: [],
    };
    const harness = setup([JSON.stringify(unreadable)]);

    await expect(
      harness.adapter.analyze({ config, imageDataUrls: ["data:image/jpeg;base64,eA=="] }),
    ).resolves.toEqual(unreadable);
  });

  it("首个结构无效时只带无效文本和 schema 摘要修复一次", async () => {
    const invalid = "{bad json containing student draft}";
    const harness = setup([invalid, JSON.stringify(successEnvelope)]);

    await expect(
      harness.adapter.analyze({ config, imageDataUrls: ["data:image/jpeg;base64,eA=="] }),
    ).resolves.toEqual(successEnvelope);

    expect(harness.create).toHaveBeenCalledTimes(2);
    const repair = harness.create.mock.calls[1][0] as {
      messages: Array<{ content: string }>;
    };
    expect(repair.messages).toHaveLength(1);
    expect(repair.messages[0].content).toContain(invalid);
    expect(repair.messages[0].content).toContain("readable");
    expect(JSON.stringify(repair.messages)).not.toContain("data:image");
  });

  it("二次响应仍无效时抛 AI_INVALID_RESPONSE", async () => {
    const harness = setup(["not-json", JSON.stringify({ readable: true })]);

    await expect(
      harness.adapter.analyze({ config, imageDataUrls: ["data:image/jpeg;base64,eA=="] }),
    ).rejects.toMatchObject({ code: "AI_INVALID_RESPONSE", status: 502 });
    expect(harness.create).toHaveBeenCalledTimes(2);
  });

  it.each([
    Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
    Object.assign(new Error("rate limited"), { status: 429 }),
  ])("将 SDK 最终 timeout/429 转成不泄漏请求内容的 502", async (providerError) => {
    const harness = setup([providerError]);

    await expect(
      harness.adapter.analyze({ config, imageDataUrls: ["data:image/jpeg;base64,eA=="] }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "AI_REQUEST_FAILED",
        status: 502,
        message: "AI 服务请求失败",
      }),
    );
  });

  it("拒绝 readable=false 携带 report 并尝试修复", async () => {
    const harness = setup([
      JSON.stringify({ ...successEnvelope, readable: false }),
      "still invalid",
    ]);

    await expect(
      harness.adapter.analyze({ config, imageDataUrls: ["data:image/jpeg;base64,eA=="] }),
    ).rejects.toMatchObject({ code: "AI_INVALID_RESPONSE" });
    expect(harness.create).toHaveBeenCalledTimes(2);
  });

  it("拒绝把远程 URL 当作作文页面发送", async () => {
    const harness = setup([JSON.stringify(successEnvelope)]);

    await expect(
      harness.adapter.analyze({
        config,
        imageDataUrls: ["https://files.example.test/student.jpg"],
      }),
    ).rejects.toThrow(/data URL/i);
    expect(harness.create).not.toHaveBeenCalled();
  });
});

describe("testOpenAIConnection", () => {
  it("不保存设置，仅用候选配置发送轻量连接测试", async () => {
    const create = vi.fn(async (input: unknown) => {
      void input;
      return { choices: [{ message: { content: "OK" } }] };
    });
    const factory: OpenAIClientFactory = vi.fn(() => ({
      chat: { completions: { create } },
    }));

    await testOpenAIConnection(
      {
        baseUrl: "https://ai.example.test/v1",
        model: "vision-model",
        apiKey: "candidate-key",
      },
      factory,
    );

    expect(factory).toHaveBeenCalledWith({
      apiKey: "candidate-key",
      baseURL: "https://ai.example.test/v1",
      timeout: 180_000,
      maxRetries: 1,
    });
    expect(create).toHaveBeenCalledOnce();
  });
});
