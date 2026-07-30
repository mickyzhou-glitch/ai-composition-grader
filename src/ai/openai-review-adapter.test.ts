// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import type { AssignmentConfig, EvaluationReport } from "../domain/contracts";
import {
  OpenAIReviewAdapter,
  testOpenAIConnection,
  type OpenAICompatibleClient,
  type OpenAIClientFactory,
  type AnalyzeCompositionInput,
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
  personalizedComment: [
    "选材真实贴近自己的生活",
    "礼物线索贯穿全文始终",
    "人物动作描写具体生动",
    "结尾感受能够回扣题目",
  ].join("\n"),
  painPoints: [
    "开头加入对比突出礼物珍贵",
    "第三段补充人物心理变化",
    "段落之间增加自然过渡句",
    "结尾写清这份礼物的意义",
  ],
  commonIssues: [],
  revisionSuggestions: [],
  grade: "A-" as const,
  diagnostics: {
    authenticityAndRelevance: { finding: "主题与事件基本一致。", action: "补写一次能体现坚持的真实选择。" },
    materialAndDetails: { finding: "关键动作有待展开。", action: "补写递水时的动作和自己的心理。" },
    structure: { finding: "五段结构完整。", action: "让第四段承接第三段的转折。" },
    language: { finding: "段首时间词较多。", action: "用动作或情绪承接上一段。" },
  },
  sampleParagraphs: Array.from({ length: 5 }, (_, index) => ({
    title: `第 ${index + 1} 段`,
    text: "我".repeat(120),
    suggestion: "补充细节。",
  })),
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
    getRuntimeConfig: vi.fn(async () => ({
      baseUrl: "https://ai.example.test/v1",
      model: "vision-model",
      apiKey: "secret-key",
    })),
  };
  return {
    create,
    factory,
    adapter: new OpenAIReviewAdapter(settings, { clientFactory: factory }),
  };
}

describe("OpenAIReviewAdapter", () => {
  it("在由服务器保管密钥的 Worker 运行时可以发起 AI 请求", async () => {
    vi.stubGlobal("window", { document: {} });
    vi.stubGlobal("navigator", {});
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(successEnvelope) } }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new OpenAIReviewAdapter({
      getRuntimeConfig: async () => ({
        baseUrl: "https://ai.example.test/v1",
        model: "vision-model",
        apiKey: "server-held-secret",
      }),
    }, { dangerouslyAllowBrowser: true });

    await expect(adapter.analyze({
      config,
      imageDataUrls: ["data:image/jpeg;base64,eA=="],
    })).resolves.toEqual(successEnvelope);
    expect(fetchMock).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it("可以一次重写完整五段示范文", async () => {
    const sampleParagraphs = report.sampleParagraphs.map((sample) => ({
      ...sample,
      text: `${sample.text}（整体优化）`,
    }));
    const harness = setup([JSON.stringify({ sampleParagraphs })]);

    await expect(harness.adapter.rewriteAllSamples({
      config,
      sampleParagraphs: report.sampleParagraphs,
      instruction: "删去无关人物",
    })).resolves.toEqual({ sampleParagraphs });

    const serialized = JSON.stringify(harness.create.mock.calls[0][0]);
    expect(serialized).toContain("重写整篇五段考场范文");
    expect(serialized).toContain("删去无关人物");
    expect(serialized).toContain("600-700");
    expect(serialized).toContain("第一段不得以时间词开头");
    expect(serialized).toContain("生日那天");
    expect(serialized).toContain("对比、照应、因果");
  });

  it("单段重写也避免流水账式时间衔接", async () => {
    const harness = setup([JSON.stringify({ text: "虽然别人的礼物十分贵重，但这份礼物更让我珍惜。" })]);

    await expect(harness.adapter.rewriteSample({
      config,
      sampleParagraphs: report.sampleParagraphs,
      index: 0,
    })).resolves.toEqual({
      text: "虽然别人的礼物十分贵重，但这份礼物更让我珍惜。",
    });

    const serialized = JSON.stringify(harness.create.mock.calls[0][0]);
    expect(serialized).toContain("第一段不得以时间词开头");
    expect(serialized).toContain("第二天放学后");
    expect(serialized).toContain("情感变化");
  });

  it("只读取 SettingsService 的原子运行时快照", async () => {
    const create = vi.fn(async (input: unknown) => {
      void input;
      return { choices: [{ message: { content: JSON.stringify(successEnvelope) } }] };
    });
    const factory = vi.fn(
      (options: Parameters<OpenAIClientFactory>[0]): OpenAICompatibleClient => {
        void options;
        return { chat: { completions: { create } } };
      },
    );
    const settings = {
      getRuntimeConfig: vi.fn(async () => ({
        baseUrl: "https://atomic.example/v1",
        model: "atomic-model",
        apiKey: "atomic-key",
      })),
      get: vi.fn(() => {
        throw new Error("non-atomic get must not be called");
      }),
      getSecret: vi.fn(() => {
        throw new Error("non-atomic getSecret must not be called");
      }),
    };
    const adapter = new OpenAIReviewAdapter(settings as never, {
      clientFactory: factory,
    });

    await adapter.analyze({ config, imageDataUrls: ["data:image/jpeg;base64,eA=="] });

    expect(settings.getRuntimeConfig).toHaveBeenCalledOnce();
    expect(settings.get).not.toHaveBeenCalled();
    expect(settings.getSecret).not.toHaveBeenCalled();
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({
      baseURL: "https://atomic.example/v1",
      apiKey: "atomic-key",
    }));
  });

  it("用设置中的 endpoint/model/key、固定超时重试和全部 data URL 发起批改", async () => {
    const harness = setup([JSON.stringify(successEnvelope)]);
    const images = [
      "data:image/jpeg;base64,Zmlyc3Q=",
      "data:image/jpeg;base64,c2Vjb25k",
      "data:image/jpeg;base64,dGhpcmQ=",
      "data:image/jpeg;base64,Zm91cnRo",
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
    for (const image of images) expect(serialized).toContain(image);
    expect(serialized).toContain(config.writingRequirements);
    expect(serialized).toContain("grade:A+|A|A-|B+|B|B-|C");
    expect(serialized).toContain("authenticityAndRelevance");
    expect(serialized).not.toContain("themeIntent");
    expect(serialized).not.toContain("total:0..40");
    expect(serialized).toContain("typo");
    expect(serialized).toContain("0..1");
    expect(serialized).toContain("尽最大努力完成批改");
    expect(serialized).toContain("六年级学生能直接看懂");
    expect(serialized).toContain("五段");
    expect(serialized).toContain("600-700");
    expect(serialized).toContain("人物关系");
    expect(serialized).toContain("多余人物");
    expect(serialized).toContain("personalizedComment 包含 2-4 条优点");
    expect(serialized).toContain("painPoints 包含 2-4 条需要修改");
    expect(serialized).toContain("每条 10-20 个汉字");
    expect(serialized).toContain("选材、内容表达、情感、情节完整性");
    expect(serialized).toContain("特别出彩");
    expect(serialized).toContain("优点只写夸奖，不解释理由");
    expect(serialized).toContain("修改建议必须指出具体段落、问题和修改方法");
    expect(serialized).toContain("结尾部分要注意扣题");
    expect(serialized).toContain("中间段落不要啰嗦");
    expect(serialized).toContain("commonIssues 和 revisionSuggestions 返回空数组");
    expect(serialized).toContain("第一段不得以时间词开头");
    expect(serialized).toContain("半小时后");
    expect(serialized).toContain("对比、照应、因果");
    expect(serialized).toContain("坐标拿不准时不要生成 annotation");
    expect(serialized).toContain("sampleParagraphs:{title:string,text:string,suggestion:string}[]");
  });

  it("将老师补充观点作为重新分析的明确依据", async () => {
    const harness = setup([JSON.stringify(successEnvelope)]);

    await harness.adapter.analyze({
      config,
      imageDataUrls: ["data:image/jpeg;base64,eA=="],
      teacherGuidance: "请重点核对正文是否支撑“学会坚持”的结尾主题。",
    } as AnalyzeCompositionInput & { teacherGuidance: string });

    const serialized = JSON.stringify(harness.create.mock.calls[0][0]);
    expect(serialized).toContain("老师补充观点");
    expect(serialized).toContain("请重点核对正文是否支撑“学会坚持”的结尾主题。");
  });

  it("兼容 ```json fenced JSON", async () => {
    const harness = setup([`\n\`\`\`json\n${JSON.stringify(successEnvelope)}\n\`\`\`\n`]);

    await expect(
      harness.adapter.analyze({ config, imageDataUrls: ["data:image/jpeg;base64,eA=="] }),
    ).resolves.toEqual(successEnvelope);
  });

  it("总体评价不是四条短句时修复后再保存", async () => {
    const verboseEnvelope = {
      ...successEnvelope,
      report: {
        ...successEnvelope.report,
        personalizedComment: "这是一整段很长而且把所有优点混合在一起的总体评价。",
        painPoints: ["修改内容也没有拆成四个清楚的小点。"],
      },
    };
    const harness = setup([
      JSON.stringify(verboseEnvelope),
      JSON.stringify(successEnvelope),
    ]);

    await expect(
      harness.adapter.analyze({
        config,
        imageDataUrls: ["data:image/jpeg;base64,eA=="],
      }),
    ).resolves.toEqual(successEnvelope);
    expect(harness.create).toHaveBeenCalledTimes(2);
  });

  it("修复后评语仅超出推荐字数时仍保留可用批改结果", async () => {
    const verboseEnvelope = {
      ...successEnvelope,
      report: {
        ...successEnvelope.report,
        personalizedComment: "这篇作文选择了真实生活中的礼物故事，能够把人物之间的感情变化写得比较清楚。",
        painPoints: ["第三段需要继续补充收到礼物时的动作、神态和心理变化，让转折过程更加具体。"],
      },
    };
    const harness = setup([
      JSON.stringify(verboseEnvelope),
      JSON.stringify(verboseEnvelope),
    ]);

    await expect(
      harness.adapter.analyze({
        config,
        imageDataUrls: ["data:image/jpeg;base64,eA=="],
      }),
    ).resolves.toEqual(verboseEnvelope);
    expect(harness.create).toHaveBeenCalledTimes(2);
  });

  it("修复后五段范文仅未达到推荐总字数时仍保留可用批改结果", async () => {
    const shortSampleEnvelope = {
      ...successEnvelope,
      report: {
        ...successEnvelope.report,
        sampleParagraphs: successEnvelope.report.sampleParagraphs.map((paragraph) => ({
          ...paragraph,
          text: "我".repeat(100),
        })),
      },
    };
    const harness = setup([
      JSON.stringify(shortSampleEnvelope),
      JSON.stringify(shortSampleEnvelope),
    ]);

    await expect(
      harness.adapter.analyze({
        config,
        imageDataUrls: ["data:image/jpeg;base64,eA=="],
      }),
    ).resolves.toEqual(shortSampleEnvelope);
    expect(harness.create).toHaveBeenCalledTimes(2);
  });

  it("兼容 MiMo 将需要修改返回为换行分隔字符串", async () => {
    const mimoEnvelope = {
      ...successEnvelope,
      report: {
        ...successEnvelope.report,
        painPoints: successEnvelope.report.painPoints.join("\n"),
      },
    };
    const harness = setup([
      JSON.stringify(mimoEnvelope),
      JSON.stringify(mimoEnvelope),
    ]);

    await expect(
      harness.adapter.analyze({
        config,
        imageDataUrls: ["data:image/jpeg;base64,eA=="],
      }),
    ).resolves.toMatchObject({
      readable: true,
      report: { painPoints: successEnvelope.report.painPoints },
    });
  });

  it("可以只重新生成优点或需要修改", async () => {
    const items = ["选材真实贴近自己的生活", "礼物线索贯穿全文始终"];
    const harness = setup([JSON.stringify({ items })]);

    await expect(harness.adapter.rewriteFeedback({
      config,
      report,
      section: "strengths",
    })).resolves.toEqual({ items });

    const serialized = JSON.stringify(harness.create.mock.calls[0][0]);
    expect(serialized).toContain("只重新生成“优点”");
    expect(serialized).toContain("由你判断生成 2-4 条");
    expect(serialized).toContain("10-20 个汉字");
    expect(serialized).toContain("只写夸奖，不解释理由");
    expect(serialized).toContain("选材、内容表达、情感、情节完整性");
  });

  it("重新生成修改建议时给六年级学生明确的修改指导", async () => {
    const items = ["结尾部分要注意回扣作文题目", "中间段落删去重复的礼物介绍"];
    const harness = setup([JSON.stringify({ items })]);

    await expect(harness.adapter.rewriteFeedback({
      config,
      report,
      section: "improvements",
    })).resolves.toEqual({ items });

    const serialized = JSON.stringify(harness.create.mock.calls[0][0]);
    expect(serialized).toContain("只重新生成“需要修改”");
    expect(serialized).toContain("指出哪一段有问题、问题是什么、具体怎么改");
    expect(serialized).toContain("修改指导，不是评价");
    expect(serialized).toContain("六年级学生能直接看懂");
  });

  it("兼容无语言标签的完整 fenced JSON", async () => {
    const harness = setup([`\n\`\`\`\n${JSON.stringify(successEnvelope)}\n\`\`\`\n`]);

    await expect(
      harness.adapter.analyze({ config, imageDataUrls: ["data:image/jpeg;base64,eA=="] }),
    ).resolves.toEqual(successEnvelope);
    expect(harness.create).toHaveBeenCalledOnce();
  });

  it("无法辨认时返回无 report 的信封", async () => {
    const unreadable = {
      readable: false,
      pageWarnings: ["第 1 页过暗，请在明亮环境下重拍。"],
      annotations: [],
    };
    const harness = setup([JSON.stringify(unreadable), JSON.stringify(unreadable)]);

    await expect(
      harness.adapter.analyze({ config, imageDataUrls: ["data:image/jpeg;base64,eA=="] }),
    ).resolves.toEqual(unreadable);
    expect(harness.create).toHaveBeenCalledTimes(2);
  });

  it("首轮误判图片不清晰时携带原图继续完成批改", async () => {
    const unreadable = {
      readable: false,
      pageWarnings: ["第 1 页过暗，请在明亮环境下重拍。"],
      annotations: [],
    };
    const harness = setup([JSON.stringify(unreadable), JSON.stringify(successEnvelope)]);

    await expect(
      harness.adapter.analyze({ config, imageDataUrls: ["data:image/jpeg;base64,eA=="] }),
    ).resolves.toEqual(successEnvelope);

    expect(harness.create).toHaveBeenCalledTimes(2);
    const continuation = JSON.stringify(harness.create.mock.calls[1][0]);
    expect(continuation).toContain("继续完成批改");
    expect(continuation).toContain("data:image/jpeg;base64,eA==");
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

  it("语义校验失败时修复提示包含动态页数、当前配置和等级规则", async () => {
    const offTopicNonC = {
      ...successEnvelope,
      report: { ...report, themeFit: "off_topic", grade: "A-" as const },
    };
    const harness = setup([
      JSON.stringify(offTopicNonC),
      JSON.stringify(successEnvelope),
    ]);

    await expect(
      harness.adapter.analyze({ config, imageDataUrls: ["data:image/jpeg;base64,eA=="] }),
    ).resolves.toEqual(successEnvelope);

    const repair = harness.create.mock.calls[1][0] as {
      messages: Array<{ content: string }>;
    };
    const prompt = repair.messages[0].content;
    expect(prompt).toContain("pageCount=1");
    expect(prompt).toContain("pageIndex");
    expect(prompt).toContain("0..0");
    expect(prompt).toContain(JSON.stringify(config));
    expect(prompt).toContain("A+");
    expect(prompt).toContain("C");
    expect(prompt).toContain("偏题");
    expect(prompt).toContain("五段");
    expect(prompt).toContain("600-700");
  });

  it("等级与四维诊断有效时不浪费修复请求", async () => {
    const validGrade = {
      ...successEnvelope,
      report: {
        ...report,
        grade: "A-" as const,
      },
    };
    const harness = setup([JSON.stringify(validGrade)]);

    const result = await harness.adapter.analyze({
      config,
      imageDataUrls: ["data:image/jpeg;base64,eA=="],
    });

    expect(result).toMatchObject({
      readable: true,
      report: { grade: "A-" },
    });
    expect(harness.create).toHaveBeenCalledOnce();
  });

  it("二次响应仍无效时抛 AI_INVALID_RESPONSE", async () => {
    const harness = setup(["not-json", JSON.stringify({ readable: true })]);

    await expect(
      harness.adapter.analyze({ config, imageDataUrls: ["data:image/jpeg;base64,eA=="] }),
    ).rejects.toMatchObject({
      code: "AI_INVALID_RESPONSE",
      status: 502,
      upstreamCode: "schema_pageWarnings_invalid_type",
    });
    expect(harness.create).toHaveBeenCalledTimes(2);
  });

  it("二次响应不是 JSON 时保留安全的解析错误类别", async () => {
    const harness = setup(["not-json", "still-not-json"]);

    await expect(
      harness.adapter.analyze({ config, imageDataUrls: ["data:image/jpeg;base64,eA=="] }),
    ).rejects.toMatchObject({
      code: "AI_INVALID_RESPONSE",
      status: 502,
      upstreamCode: "json_parse",
    });
    expect(harness.create).toHaveBeenCalledTimes(2);
  });

  it("首个空 content 也进入一次结构修复", async () => {
    const harness = setup([null, JSON.stringify(successEnvelope)]);

    await expect(
      harness.adapter.analyze({ config, imageDataUrls: ["data:image/jpeg;base64,eA=="] }),
    ).resolves.toEqual(successEnvelope);
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

  it("retains a safe upstream error category without exposing provider details", async () => {
    const harness = setup([Object.assign(new Error("provider detail"), { status: 400, code: "image_input_denied" })]);

    await expect(
      harness.adapter.analyze({ config, imageDataUrls: ["data:image/jpeg;base64,eA=="] }),
    ).rejects.toEqual(expect.objectContaining({
      code: "AI_REQUEST_FAILED",
      upstreamStatus: 400,
      upstreamCode: "image_input_denied",
      message: "AI 服务请求失败",
    }));
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
