// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  isLegacyEvaluationReport,
  type AssignmentConfig,
  type LegacyEvaluationReport,
} from "../domain/contracts";
import { formatRevisionTeacherGuidance } from "../reanalysis/contracts";
import type { OpenAIClientFactory, OpenAICompatibleClient } from "./openai-review-adapter";
import { CompositionReviewAdapter } from "./composition-review-adapter";

const config: AssignmentConfig = {
  title: "一次难忘的经历",
  grade: "六年级",
  writingRequirements: "写一件真实的事。",
  targetCharacters: 10,
  structureRequirements: "起因、经过、结果完整。",
  scoringFocus: "内容具体。",
  templateType: "custom",
  sampleParagraphCount: 1,
};

function sampleParagraphs(count: number) {
  const baseLength = Math.floor(10 / count);
  const remainder = 10 - baseLength * count;
  return Array.from({ length: count }, (_, index) => ({
    title: `第${index + 1}段`,
    text: "文".repeat(baseLength + (index === count - 1 ? remainder : 0)),
    suggestion: "补充动作与心理。",
  }));
}

const report: LegacyEvaluationReport = {
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
  const create = vi.fn(async (input: unknown) => {
    void input;
    return {
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
    };
  });
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

  it("keeps revision guidance subordinate to recognizable source facts", async () => {
    const harness = setup();
    const teacherGuidance = formatRevisionTeacherGuidance(
      "结尾主题与正文经历不一致",
      "依据可辨认原文重新判断主题并修改建议",
    );

    await harness.adapter.analyzeText({
      config,
      pages: [{ pageIndex: 0, text: "我终于明白了坚持的意义。" }],
      teacherGuidance,
      studentName: "小艾",
    });

    const request = harness.create.mock.calls[0][0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const systemPrompt = request.messages.find(({ role }) => role === "system")?.content;
    expect(systemPrompt).toContain("[不合适原因]");
    expect(systemPrompt).toContain("[修改要求]");
    expect(systemPrompt).toMatch(/与(?:可辨认)?原文冲突时，?以原文为准/u);
    expect(systemPrompt).toContain("不得虚构关键经历");
  });

  it("describes the complete report contract instead of relying on TypeScript type names", async () => {
    const harness = setup();
    const request = harness.create.getMockImplementation();
    harness.create.mockImplementation(async (...args) => {
      const result = await request!(...args);
      const payload = JSON.parse(result.choices[0].message.content);
      payload.report.sampleParagraphs = Array.from({ length: 5 }, (_, index) => ({
        title: `第${index + 1}段`,
        text: "我".repeat(120),
        suggestion: "围绕核心事件补充具体细节。",
      }));
      return { choices: [{ message: { content: JSON.stringify(payload) } }] };
    });

    await harness.adapter.analyzeText({
      config: {
        ...config,
        templateType: "preset_self_applause",
        targetCharacters: 600,
        sampleParagraphCount: 5,
      },
      pages: [{ pageIndex: 0, text: "我终于明白了坚持的意义。" }],
      studentName: "小艾",
    });

    const sentRequest = harness.create.mock.calls[0][0] as { messages: Array<{ content: string }> };
    const prompt = sentRequest.messages[0].content;
    expect(prompt).toContain("themeFit:fits|partial|off_topic");
    expect(prompt).toContain("authenticityAndRelevance:{finding:string,action:string}");
    expect(prompt).toContain("parentFeedbacks 必须按固定顺序生成恰好三份");
    expect(prompt).toContain("小艾家长");
    expect(prompt).toContain("sampleParagraphs 必须恰好 5 段");
    expect(prompt).not.toContain("2-4 条");
    expect(prompt).toContain("根据作文实际内容生成优点和修改项");
    expect(prompt).toContain("annotationAnchors={pageIndex:integer");
    for (const phrase of [
      "少见但可能",
      "时间、地点和行动",
      "人物年龄、身份、关系与行为能力",
      "物品归属与状态",
      "原因是否足以推出结果",
      "请向学生核实",
      "不得虚构关键经历",
      "严重矛盾导致题目要求的核心内容无法成立时 grade 必须为 C",
    ]) {
      expect(prompt).toContain(phrase);
    }
  });

  it("disables DeepSeek default thinking mode for content generation", async () => {
    const harness = setup();
    harness.settings.getRuntimeConfig.mockResolvedValue({
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      apiKey: "content-secret",
    });

    await harness.adapter.analyzeText({
      config,
      pages: [{ pageIndex: 0, text: "我终于明白了坚持的意义。" }],
      studentName: "小艾",
    });

    expect(harness.create.mock.calls[0][0]).toMatchObject({
      thinking: { type: "disabled" },
    });
  });

  it("repairs one invalid provider response before failing the analysis", async () => {
    const harness = setup();
    const request = harness.create.getMockImplementation();
    harness.create
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({
        report: { ...report, parentFeedbacks: [] },
        annotationAnchors: [],
      }) } }] })
      .mockImplementationOnce(request!);

    await expect(harness.adapter.analyzeText({
      config,
      pages: [{ pageIndex: 0, text: "我终于明白了坚持的意义。" }],
      studentName: "小艾",
    })).resolves.toMatchObject({ report, annotationAnchors: [{ pageIndex: 0 }] });

    expect(harness.create).toHaveBeenCalledTimes(2);
    const repairRequest = harness.create.mock.calls[1][0] as { messages: Array<{ content: string }> };
    expect(repairRequest.messages[1].content).toContain("parent_feedback_count");
    expect(repairRequest.messages[1].content).toContain("我终于明白了坚持的意义");
  });

  it("逐项核对编号结构要求并修复缺项响应", async () => {
    const harness = setup();
    const numberedConfig = {
      ...config,
      structureRequirements: "1. 开头倒叙。 2. 交代困难。 3. 详写努力。",
    };
    const invalid = {
      report: {
        ...report,
        diagnostics: {
          ...report.diagnostics,
          structure: { finding: "结构基本完整。", action: "补充努力过程。" },
        },
      },
      annotationAnchors: [],
    };
    const repaired = {
      report: {
        ...report,
        diagnostics: {
          ...report.diagnostics,
          structure: {
            finding: [
              "【第1项】符合：首段先写比赛结果。",
              "【第2项】部分符合：第二段只简单提到困难。",
              "【第3项】不符合：没有详写努力过程。",
            ].join("\n"),
            action: "第二段具体交代困难，第三段补写努力过程。",
          },
        },
      },
      annotationAnchors: [],
    };
    harness.create
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(invalid) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(repaired) } }] });

    await expect(harness.adapter.analyzeText({
      config: numberedConfig,
      pages: [{ pageIndex: 0, text: "我参加了比赛。" }],
      studentName: "小艾",
    })).resolves.toMatchObject({ report: repaired.report });

    const firstPrompt = JSON.stringify(harness.create.mock.calls[0][0]);
    const repairPrompt = JSON.stringify(harness.create.mock.calls[1][0]);
    expect(firstPrompt).toContain("【第1项】");
    expect(firstPrompt).toContain("详写努力");
    expect(repairPrompt).toContain("structure_coverage");
  });

  it("编号结构要求修复后仍缺项时拒绝保存", async () => {
    const harness = setup();
    const incomplete = {
      report: {
        ...report,
        diagnostics: {
          ...report.diagnostics,
          structure: { finding: "结构基本完整。", action: "补充努力过程。" },
        },
      },
      annotationAnchors: [],
    };
    harness.create.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify(incomplete) } }],
    });

    await expect(harness.adapter.analyzeText({
      config: {
        ...config,
        structureRequirements: "1. 开头倒叙。 2. 交代困难。 3. 详写努力。",
      },
      pages: [{ pageIndex: 0, text: "我参加了比赛。" }],
      studentName: "小艾",
    })).rejects.toMatchObject({
      code: "AI_INVALID_RESPONSE",
      upstreamCode: "structure_coverage",
    });
    expect(harness.create).toHaveBeenCalledTimes(2);
  });

  it("历史自定义配置默认要求5段并拒绝三段响应", async () => {
    const harness = setup();
    harness.create
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({
        report: { ...report, sampleParagraphs: sampleParagraphs(3) },
        annotationAnchors: [],
      }) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({
        texts: sampleParagraphs(3).map(({ text }) => text),
      }) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({
        texts: sampleParagraphs(3).map(({ text }) => text),
      }) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({
        texts: sampleParagraphs(3).map(({ text }) => text),
      }) } }] });

    await expect(harness.adapter.analyzeText({
      config: { ...config, sampleParagraphCount: undefined },
      pages: [{ pageIndex: 0, text: "爸爸送给我一根跳绳。" }],
      studentName: "小艾",
    })).rejects.toMatchObject({ upstreamCode: "sample_paragraphs_p3" });

    const request = harness.create.mock.calls[0][0] as { messages: Array<{ content: string }> };
    expect(request.messages[0].content).toContain("sampleParagraphs 必须恰好 5 段");
  });

  it("历史自定义配置接受五段响应", async () => {
    const harness = setup();
    harness.create.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      report: { ...report, sampleParagraphs: sampleParagraphs(5) },
      annotationAnchors: [],
    }) } }] });

    const result = await harness.adapter.analyzeText({
      config: { ...config, sampleParagraphCount: undefined },
      pages: [{ pageIndex: 0, text: "爸爸送给我一根跳绳。" }],
      studentName: "小艾",
    });

    expect(isLegacyEvaluationReport(result.report)).toBe(true);
    if (!isLegacyEvaluationReport(result.report)) throw new Error("expected legacy report");
    expect(result.report.sampleParagraphs).toHaveLength(5);
  });

  it("显式段落数同时约束提示词和响应校验", async () => {
    const harness = setup();
    harness.create.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      report: { ...report, sampleParagraphs: sampleParagraphs(3) },
      annotationAnchors: [],
    }) } }] });

    const result = await harness.adapter.analyzeText({
      config: { ...config, sampleParagraphCount: 3 },
      pages: [{ pageIndex: 0, text: "爸爸送给我一根跳绳。" }],
      studentName: "小艾",
    });

    expect(isLegacyEvaluationReport(result.report)).toBe(true);
    if (!isLegacyEvaluationReport(result.report)) throw new Error("expected legacy report");
    expect(result.report.sampleParagraphs).toHaveLength(3);

    const request = harness.create.mock.calls[0][0] as { messages: Array<{ content: string }> };
    expect(request.messages[0].content).toContain("sampleParagraphs 必须恰好 3 段");
  });

  it("以教师填写的年级、字数和格式作为唯一示范标准", async () => {
    const harness = setup();
    harness.create.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      report: {
        ...report,
        sampleParagraphs: [{
          title: "完整范文",
          text: "我".repeat(600),
          suggestion: "按教师要求完成全文。",
        }],
      },
      annotationAnchors: [],
    }) } }] });

    await harness.adapter.analyzeText({
      config: {
        ...config,
        grade: "五升六",
        targetCharacters: 600,
        writingRequirements: "写一次真实活动。",
        structureRequirements: "按开头、经过、高潮、结果、感受展开。",
        scoringFocus: "过程具体。",
      },
      pages: [{ pageIndex: 0, text: "我参加了跳绳比赛。" }],
      studentName: "小艾",
    });

    const prompt = JSON.stringify(harness.create.mock.calls[0][0]);
    expect(prompt).toContain("五升六");
    expect(prompt).toContain("550-700");
    expect(prompt).toContain("不得写成初中生或成人范文");
    expect(prompt).toContain("按开头、经过、高潮、结果、感受展开");
  });

  it("分段字数未达标时直接接受模型结果，不触发修复", async () => {
    const rangeConfig = {
      ...config,
      sampleParagraphCount: 5,
      structureRequirements: [
        "开头段（建议字数：100-150字）：点题。",
        "第二段（建议字数：100-150字）：写礼物。",
        "第三段（建议字数：200-250字）：写事件。",
        "第四段（建议字数：100-150字）：写影响。",
        "结尾段（建议字数：100-150字）：写感悟。",
      ].join("\n\n"),
    };
    const rangeParagraphs = [100, 100, 200, 100, 100].map((length, index) => ({
      title: `第 ${index + 1} 段`,
      text: "我".repeat(length),
      suggestion: "补充具体细节。",
    }));
    const invalidParagraphs = rangeParagraphs.map((paragraph, index) =>
      index === 2 ? { ...paragraph, text: "我".repeat(199) } : paragraph,
    );
    const harness = setup();
    harness.create.mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({
      report: { ...report, sampleParagraphs: invalidParagraphs },
      annotationAnchors: [],
    }) } }] });
    await expect(harness.adapter.analyzeText({
      config: rangeConfig,
      pages: [{ pageIndex: 0, text: "我参加了活动。" }],
      studentName: "小艾",
    })).resolves.toMatchObject({
      report: { sampleParagraphs: invalidParagraphs },
    });
    expect(harness.create).toHaveBeenCalledTimes(1);
  });

  it("书信题不追加小学记叙文和禁用时间词规则", async () => {
    const harness = setup();

    await harness.adapter.analyzeText({
      config: {
        ...config,
        grade: "初二",
        writingRequirements: "给未来的自己写一封信。",
        structureRequirements: "包含称呼、正文、祝福语、署名和日期。",
        scoringFocus: "格式正确，表达真诚。",
      },
      pages: [{ pageIndex: 0, text: "亲爱的未来的我：你好！" }],
      studentName: "小艾",
    });

    const prompt = JSON.stringify(harness.create.mock.calls[0][0]);
    expect(prompt).toContain("给未来的自己写一封信");
    expect(prompt).toContain("称呼、正文、祝福语、署名和日期");
    expect(prompt).not.toContain("不得写成初中生");
    expect(prompt).not.toContain("段首不要使用");
  });

  it("范文超过700字时直接返回并保留原报告", async () => {
    const harness = setup();
    const longParagraphs = Array.from({ length: 5 }, (_, index) => ({
      title: `第 ${index + 1} 段`,
      text: "我".repeat(150),
      suggestion: "补充具体细节。",
    }));
    harness.create.mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({
      report: { ...report, sampleParagraphs: longParagraphs },
      annotationAnchors: [],
    }) } }] });

    await expect(harness.adapter.analyzeText({
      config: { ...config, targetCharacters: 600, sampleParagraphCount: 5 },
      pages: [{ pageIndex: 0, text: "我参加了跳绳比赛。" }],
      studentName: "小艾",
    })).resolves.toMatchObject({
      report: {
        themeReason: report.themeReason,
        sampleParagraphs: longParagraphs,
      },
      annotationAnchors: [],
    });

    expect(harness.create).toHaveBeenCalledTimes(1);
  });

  it("总字数低于550时直接返回，不触发示范文修复", async () => {
    const harness = setup();
    const shortReport = {
      ...report,
      sampleParagraphs: Array.from({ length: 5 }, (_, index) => ({
        title: `第 ${index + 1} 段`,
        text: "我".repeat(100),
        suggestion: "补充具体细节。",
      })),
    };
    harness.create.mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({
      report: shortReport,
      annotationAnchors: [],
    }) } }] });

    await expect(harness.adapter.analyzeText({
      config: { ...config, targetCharacters: 600, sampleParagraphCount: 5 },
      pages: [{ pageIndex: 0, text: "我参加了跳绳比赛。" }],
      studentName: "小艾",
    })).resolves.toMatchObject({
      report: shortReport,
      annotationAnchors: [],
    });
    expect(harness.create).toHaveBeenCalledTimes(1);
  });

  it("accepts a valid custom report when a sample paragraph begins with a time word", async () => {
    const harness = setup();
    const text = "清晨的阳光透过窗帘，我看着准备好的跑鞋，心里充满期待。";
    harness.create.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      report: {
        ...report,
        sampleParagraphs: [{
          title: "运动会开场",
          text,
          suggestion: "用环境描写交代活动背景。",
        }],
      },
      annotationAnchors: [],
    }) } }] });

    await expect(harness.adapter.analyzeText({
      config: { ...config, targetCharacters: text.match(/\p{Script=Han}/gu)?.length ?? 1 },
      pages: [{ pageIndex: 0, text: "清晨的阳光透过窗帘，我准备参加运动会。" }],
      studentName: "小艾",
    })).resolves.toMatchObject({
      report: { sampleParagraphs: [{ text: expect.stringMatching(/^清晨/u) }] },
    });
    expect(harness.create).toHaveBeenCalledTimes(1);
  });

  it("normalizes numbered feedback and accepts concise provider wording over twenty characters", async () => {
    const harness = setup();
    const providerReport = {
      ...report,
      personalizedComment: [
        "1. 选材来自真实生活，母子之间的情感变化写得自然真切",
        "2、篮球比赛中的坚持过程完整，结尾感悟能够回扣题目",
      ].join("\n"),
      painPoints: [
        "1. 生日收到鞋子时要补充自己的神态、动作和心理变化",
        "2、篮球比赛最后一节要写清想起妈妈后如何坚持完成比赛",
      ],
    };
    harness.create.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      report: providerReport,
      annotationAnchors: [],
    }) } }] });

    await expect(harness.adapter.analyzeText({
      config,
      pages: [{ pageIndex: 0, text: "我终于明白了坚持的意义。" }],
      studentName: "小艾",
    })).resolves.toMatchObject({
      report: {
        personalizedComment: [
          "选材来自真实生活，母子之间的情感变化写得自然真切",
          "篮球比赛中的坚持过程完整，结尾感悟能够回扣题目",
        ].join("\n"),
        painPoints: [
          "生日收到鞋子时要补充自己的神态、动作和心理变化",
          "篮球比赛最后一节要写清想起妈妈后如何坚持完成比赛",
        ],
      },
    });
    expect(harness.create).toHaveBeenCalledTimes(1);
  });

  it("normalizes recoverable feedback formatting without retrying the model", async () => {
    const harness = setup();
    const longStrength = "运动会过程中的动作、心理和现场气氛描写彼此配合，让长跑比赛的紧张感和坚持到底的主题都很清楚";
    harness.create.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      report: {
        ...report,
        personalizedComment: `1. ${longStrength}\n\n2、结尾能够回扣坚持的主题`,
        painPoints: ["1. 第二段压缩到校前的过程", "2、比赛部分补充冲线动作"],
        commonIssues: ["重复内容"],
        revisionSuggestions: ["压缩开头"],
      },
      annotationAnchors: [],
    }) } }] });

    const result = await harness.adapter.analyzeText({
      config,
      pages: [{ pageIndex: 0, text: "我参加了运动会。" }],
      studentName: "小艾",
    });

    expect(result.report).toMatchObject({
      personalizedComment: `${longStrength}\n结尾能够回扣坚持的主题`,
      painPoints: ["第二段压缩到校前的过程", "比赛部分补充冲线动作"],
      commonIssues: [],
      revisionSuggestions: [],
    });
    expect(harness.create).toHaveBeenCalledTimes(1);
  });

  it("accepts more than four non-empty improvements", async () => {
    const harness = setup();
    const invalidReport = {
      ...report,
      painPoints: [
        "1. 第二段补充事情发生的具体背景",
        "2、第三段写清比赛过程中的心理变化",
        "3.",
        "第四段补充冲线前后的具体动作",
        "5. 结尾部分要注意回扣题目中心",
        "五、开头部分压缩起床和到校的过程",
        "10) 第六段补充比赛结束后的真实感受",
        "10.5公里长跑过程描写具体",
        "2026.8月参加比赛的经历很真实",
        "8:30比赛开始时的紧张感写得真实",
        "5、6公里长跑过程描写具体",
        "3）4班同学配合默契",
        "五、六公里路程并不算远",
        "-10°C环境描写真实",
      ],
    };
    harness.create.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      report: invalidReport,
      annotationAnchors: [],
    }) } }] });

    await expect(harness.adapter.analyzeText({
      config,
      pages: [{ pageIndex: 0, text: "我终于明白了坚持的意义。" }],
      studentName: "小艾",
    })).resolves.toMatchObject({
      report: {
        painPoints: [
          "第二段补充事情发生的具体背景",
          "第三段写清比赛过程中的心理变化",
          "第四段补充冲线前后的具体动作",
          "结尾部分要注意回扣题目中心",
          "开头部分压缩起床和到校的过程",
          "第六段补充比赛结束后的真实感受",
          "10.5公里长跑过程描写具体",
          "2026.8月参加比赛的经历很真实",
          "8:30比赛开始时的紧张感写得真实",
          "5、6公里长跑过程描写具体",
          "3）4班同学配合默契",
          "五、六公里路程并不算远",
          "-10°C环境描写真实",
        ],
      },
    });
    expect(harness.create).toHaveBeenCalledTimes(1);
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
    })).rejects.toMatchObject({
      code: "AI_INVALID_RESPONSE",
      upstreamCode: "schema_annotationAnchors_0_unrecognized_keys",
    });
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
    })).rejects.toMatchObject({
      code: "AI_INVALID_RESPONSE",
      upstreamCode: "parent_feedback_count",
    });
  });
});
