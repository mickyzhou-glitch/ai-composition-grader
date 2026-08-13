// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import type { AssignmentConfig, EvaluationReport } from "../domain/contracts";
import type { OpenAIClientFactory, OpenAICompatibleClient } from "./openai-review-adapter";
import { CompositionReviewAdapter } from "./composition-review-adapter";

const config: AssignmentConfig = {
  title: "一次难忘的经历",
  grade: "六年级",
  writingRequirements: "写一件真实的事。",
  targetCharacters: 500,
  structureRequirements: "起因、经过、结果完整。",
  scoringFocus: "内容具体。",
  templateType: "custom",
};

const report: EvaluationReport = {
  themeFit: "fits",
  themeReason: "围绕真实经历展开。",
  personalizedComment: "选材真实贴近日常生活\n关键动作描写比较具体",
  painPoints: ["第三段补充自己的心理变化", "结尾部分要注意回扣题目"],
  commonIssues: [],
  revisionSuggestions: [],
  grade: "B+",
  diagnostics: {
    authenticityAndRelevance: { finding: "事件真实。", action: "保留真实细节。" },
    materialAndDetails: { finding: "心理变化不足。", action: "第三段补写心理。" },
    structure: { finding: "结构基本完整。", action: "结尾回扣题目。" },
    language: { finding: "表达通顺。", action: "精简重复句。" },
  },
  sampleParagraphs: [{ title: "示范", text: "一段更具体的示范文字。", suggestion: "补充心理变化。" }],
  parentFeedbacks: [
    { style: "warm", title: "亲切详细", content: "小艾家长，本次作文选材真实，建议补充第三段心理变化。" },
    { style: "professional", title: "专业清晰", content: "小艾家长，本次作文结构完整，第三段需要补足心理变化。" },
    { style: "concise", title: "简短微信版", content: "小艾家长，作文选材真实，第三段请补写心理变化。" },
  ],
};

function setup() {
  const create = vi.fn(async () => ({
    choices: [{ message: { content: JSON.stringify({
      report,
      annotationAnchors: [{
        pageIndex: 0,
        category: "structure",
        anchorText: "我终于明白了",
        comment: "这里需要回扣题目",
        isHighlight: false,
      }],
    }) } }],
  }));
  const factory = vi.fn((options: Parameters<OpenAIClientFactory>[0]): OpenAICompatibleClient => {
    void options;
    return { chat: { completions: { create } } };
  });
  const settings = {
    getRuntimeConfig: vi.fn(async () => ({
      baseUrl: "https://content.example/v1",
      model: "content-model",
      apiKey: "content-secret",
    })),
  };
  return { create, factory, settings, adapter: new CompositionReviewAdapter(settings, { clientFactory: factory }) };
}

describe("CompositionReviewAdapter", () => {
  it("uses the content role and sends OCR text without any image payload", async () => {
    const harness = setup();

    await expect(harness.adapter.analyzeText({
      config,
      pages: [{ pageIndex: 0, text: "我终于明白了坚持的意义。" }],
      studentName: "小艾",
    })).resolves.toMatchObject({ report, annotationAnchors: [{ pageIndex: 0 }] });

    expect(harness.settings.getRuntimeConfig).toHaveBeenCalledWith("content");
    const serialized = JSON.stringify(harness.create.mock.calls[0][0]);
    expect(serialized).toContain("我终于明白了坚持的意义");
    expect(serialized).not.toContain("image_url");
    expect(serialized).not.toContain("data:image");
    expect(serialized).not.toContain("/api/ai/files/");
    expect(serialized).not.toContain('"x"');
    expect(serialized).not.toContain('"y"');
  });

  it("rejects coordinates supplied by the content model", async () => {
    const harness = setup();
    const request = harness.create.getMockImplementation();
    harness.create.mockImplementation(async (...args) => {
      const result = await request!(...args);
      const payload = JSON.parse(result.choices[0].message.content);
      payload.annotationAnchors[0].x = 0.5;
      return { choices: [{ message: { content: JSON.stringify(payload) } }] };
    });

    await expect(harness.adapter.analyzeText({
      config,
      pages: [{ pageIndex: 0, text: "我终于明白了坚持的意义。" }],
      studentName: "小艾",
    })).rejects.toMatchObject({ code: "AI_INVALID_RESPONSE" });
  });

  it("rejects a structurally valid report that omits the three parent feedback variants", async () => {
    const harness = setup();
    const request = harness.create.getMockImplementation();
    harness.create.mockImplementation(async (...args) => {
      const result = await request!(...args);
      const payload = JSON.parse(result.choices[0].message.content);
      payload.report.parentFeedbacks = [];
      return { choices: [{ message: { content: JSON.stringify(payload) } }] };
    });

    await expect(harness.adapter.analyzeText({
      config,
      pages: [{ pageIndex: 0, text: "我终于明白了坚持的意义。" }],
      studentName: "小艾",
    })).rejects.toMatchObject({ code: "AI_INVALID_RESPONSE" });
  });
});
