// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  NO_LEAK_ELEMENT,
  OPENING_FORESHADOW_NOTE,
  OPENING_FUNCTION_ELEMENT,
  OPENING_FUNCTION_SCENE_ELEMENT,
  OPENING_NO_SUPPRESSION_ELEMENT,
  describeStructureTask,
  evidenceAppearsIn,
  failingParagraphs,
  judgeStructureAudit,
  parseStructureTasks,
  parseTaskCharacterTarget,
  structureAuditPrompt,
  structureAuditResponseSchema,
  structureFailureCount,
  structureRepairConstraints,
  structureRepairFeedback,
  type StructureTask,
} from "./structure-audit";
import { structureAuditRoundSchema } from "../domain/structure-audit";

/** 章皓轩这篇作业的 structureRequirements 原文。 */
const ZHX_REQUIREMENTS = [
  "文章必须严格遵循以下五个段落的逻辑功能：",
  "第一段：开头引入段（约100字）",
  "要求： 使用名人名言引入；埋下“抑”的伏笔或设置悬念；点出特定人物。注意名人名言的核心要与文章内容一致。",
  "第二段：“抑”的铺垫段（约100字）",
  "要求： 描写人物的“缺点”或“误解”（如外貌邋遢、脾气古怪）；通过他人态度（群体反应）侧面烘托，或环境描写渲染疏离、冷漠的氛围。",
  "第三段：“扬”的转折段（约200字）",
  "要求： 发生意外事件打破固有认知；人物做出出乎意料的正面举动；必须使用正面的环境描写（如光线变化、天气好转）来象征情感转折。",
  "第四段：真相揭示段（约100字）",
  "要求： 通过第三方（如邻居、其他亲友）或某个物件（如照片、旧物）揭露真相；解释前文的“误解”或行为动机；保留一点余味引人深思。",
  "第五段：结尾升华段（约100字）",
  "要求： 描述人物现状；呼应开头的环境元素并赋予新的情感意义；点题（为什么打动了我），进行情感或哲理升华。",
].join("\n");

const han = (count: number, seed = "字") => seed.repeat(count);

function reply(tasks: StructureTask[], essay: string[], unmet: Record<number, string[]> = {}, evidenceOverride: Record<number, string> = {}) {
  return structureAuditResponseSchema.parse({
    paragraphs: tasks.map((task, index) => ({
      paragraph: index + 1,
      elements: task.elements.map((requirement, elementIndex) => {
        const bad = (unmet[index + 1] ?? []).includes(requirement);
        return {
          id: elementIndex + 1,
          status: bad ? "unmet" : "met",
          evidence: bad ? "违规原句" : (evidenceOverride[index + 1] ?? essay[index]!.slice(0, 10)),
        };
      }),
      reason: "",
    })),
  });
}

describe("parseStructureTasks", () => {
  it("章皓轩五段要求拆成 5 条任务，带要素与约数字数", () => {
    const tasks = parseStructureTasks(ZHX_REQUIREMENTS, 5)!;
    expect(tasks).toHaveLength(5);
    expect(tasks[0]!.elements).toContain("使用名人名言引入");
    expect(tasks[0]!.elements).toContain("注意名人名言的核心要与文章内容一致");
    expect(tasks[0]!.characterTarget).toMatchObject({ requirement: "约100字", minimum: 70, maximum: 130 });
    expect(tasks[2]!.characterTarget).toMatchObject({ minimum: 140, maximum: 260 });
    expect(tasks[4]!.elements).not.toContain(NO_LEAK_ELEMENT);
    expect(tasks[3]!.elements).toContain(NO_LEAK_ELEMENT);
  });

  it.each([
    ["第一段：", "第一段：引入。\n第二段：抑。\n第三段：扬。"],
    ["第1段：", "第1段：引入。\n第2段：抑。\n第3段：扬。"],
    ["同一行连写", "第一段：引入。第二段：抑。第三段：扬。"],
    ["1. 编号", "1. 引入人物 2. 抑的铺垫 3. 扬的转折"],
  ])("支持 %s 写法", (_label, value) => {
    const tasks = parseStructureTasks(value, 3)!;
    expect(tasks).toHaveLength(3);
    expect(tasks.map((task) => task.paragraph)).toEqual([1, 2, 3]);
  });

  it("编号条数与段数不一致时不当作逐段任务", () => {
    expect(parseStructureTasks("1. 开头点题 2. 结尾升华", 5)).toBeNull();
  });

  it("正文里提到「第一段」不会被误拆成标题", () => {
    const tasks = parseStructureTasks("第一段：写天气。\n第二段：呼应第一段的环境，点题。", 2)!;
    expect(tasks[1]!.task).toContain("呼应第一段的环境");
  });
});

describe("第一段口径（家奇订正）", () => {
  const tasks = parseStructureTasks(ZHX_REQUIREMENTS, 5)!;

  it("欲扬先抑结构的第一段追加功能限定与禁止展开「抑」，「埋下抑的伏笔」改为点到即可", () => {
    expect(tasks[0]!.systemRules).toEqual([OPENING_FUNCTION_ELEMENT, OPENING_NO_SUPPRESSION_ELEMENT, NO_LEAK_ELEMENT]);
    expect(tasks[0]!.elements).toContain(`埋下“抑”的伏笔或设置悬念${OPENING_FORESHADOW_NOTE}`);
    expect(tasks[1]!.elements).not.toContain(OPENING_NO_SUPPRESSION_ELEMENT);
    const described = describeStructureTask(tasks[0]!);
    expect(described).toContain("点出人物，最多再加一句过渡");
    expect(described).toContain("「抑」放在第二段");
  });

  it("不是欲扬先抑结构时不追加第一段口径", () => {
    const plain = parseStructureTasks("第一段：用名言引入。\n第二段：写经过。\n第三段：写感悟。", 3)!;
    expect(plain[0]!.elements).not.toContain(OPENING_NO_SUPPRESSION_ELEMENT);
    expect(plain[0]!.systemRules).toEqual([NO_LEAK_ELEMENT]);
  });

  it("复核提示词写明第一段判定口径", () => {
    const prompt = structureAuditPrompt(tasks, "", false);
    expect(prompt).toContain("第一段只写名人名言、简单解释名言、点出人物，最多一句过渡");
    expect(prompt).toContain("两句及以上、或约三分之一以上篇幅");
    expect(prompt).toContain("「抑」的铺垫属于第二段");
  });

  it("第一段大段写「抑」被判 unmet 时该段 fail，返修硬约束点名违规原句", () => {
    const essay = [han(100), han(100), han(200), han(100), han(100)];
    const round = judgeStructureAudit(essay, tasks, reply(tasks, essay, { 1: [OPENING_NO_SUPPRESSION_ELEMENT] }), { round: 0, allowSuperseded: false });
    expect(round.passed).toBe(false);
    expect(failingParagraphs(round)).toEqual([1]);
    const [constraint] = structureRepairConstraints(round);
    expect(constraint!.mustFix[0]).toContain("违反「第一段不得展开人物的「抑」");
    expect(constraint!.mustFix[0]).toContain("违规原句");
  });

  it("禁止性要素判 met 时不要求摘抄原句", () => {
    const essay = [han(100), han(100), han(200), han(100), han(100)];
    const response = reply(tasks, essay);
    const opening = response.paragraphs[0]!.elements.find((item) => item.id === tasks[0]!.elements.indexOf(OPENING_NO_SUPPRESSION_ELEMENT) + 1)!;
    opening.evidence = "无";
    const round = judgeStructureAudit(essay, tasks, response, { round: 0, allowSuperseded: false });
    expect(round.passed).toBe(true);
  });
});

describe("judgeStructureAudit", () => {
  const tasks = parseStructureTasks(ZHX_REQUIREMENTS, 5)!;
  const good = [han(100), han(100), han(200), han(100), han(100)];

  it("全部 met 且证据可在原文找到、字数在范围内时通过，记录可被 schema 落库", () => {
    const round = judgeStructureAudit(good, tasks, reply(tasks, good), { round: 0, allowSuperseded: false });
    expect(round.passed).toBe(true);
    expect(() => structureAuditRoundSchema.parse(round)).not.toThrow();
    expect(round.paragraphs[0]!.length).toMatchObject({ actual: 100, pass: true });
  });

  it("章皓轩类问题：名言不符、第二段泄露转折、第四段抢升华都判 fail", () => {
    const round = judgeStructureAudit(good, tasks, reply(tasks, good, {
      1: ["注意名人名言的核心要与文章内容一致"],
      2: [NO_LEAK_ELEMENT],
      4: ["保留一点余味引人深思"],
    }), { round: 0, allowSuperseded: false });
    expect(failingParagraphs(round)).toEqual([1, 2, 4]);
  });

  it("met 却给不出原文证据时判 fail（模型不能空口放行）", () => {
    const round = judgeStructureAudit(good, tasks, reply(tasks, good, {}, { 3: "范文里没有的句子" }), { round: 0, allowSuperseded: false });
    expect(failingParagraphs(round)).toEqual([3]);
    expect(round.paragraphs[2]!.elements.some((item) => item.status === "met" && !item.evidenceFound)).toBe(true);
  });

  it("漏判要素按 unmet 处理", () => {
    const response = reply(tasks, good);
    response.paragraphs[1]!.elements.pop();
    expect(judgeStructureAudit(good, tasks, response, { round: 0, allowSuperseded: false }).passed).toBe(false);
  });

  it.each([
    [69, false], [70, true], [130, true], [131, false],
  ])("约100字：第一段 %i 字 → pass=%s（偏离超过三成判 fail）", (count, pass) => {
    const essay = [han(count), ...good.slice(1)];
    const round = judgeStructureAudit(essay, tasks, reply(tasks, essay), { round: 0, allowSuperseded: false });
    expect(round.paragraphs[0]!.pass).toBe(pass);
    if (!pass) expect(round.paragraphs[0]!.failures.at(-1)).toMatch(count > 100 ? /压缩/u : /扩写/u);
  });

  it("老师本轮写了硬性字数的段不再套配置约数", () => {
    const essay = [han(30), ...good.slice(1)];
    const round = judgeStructureAudit(essay, tasks, reply(tasks, essay), { round: 0, allowSuperseded: false, skipLengthFor: new Set([1]) });
    expect(round.passed).toBe(true);
  });

  it("没有教师补充意见时 superseded 一律按 unmet", () => {
    const response = reply(tasks, good);
    response.paragraphs[0]!.elements[0]!.status = "superseded";
    expect(judgeStructureAudit(good, tasks, response, { round: 0, allowSuperseded: false }).passed).toBe(false);
    expect(judgeStructureAudit(good, tasks, response, { round: 0, allowSuperseded: true }).passed).toBe(true);
  });

  it("段序不对时拒绝复核结果", () => {
    const response = reply(tasks, good);
    response.paragraphs.reverse();
    expect(() => judgeStructureAudit(good, tasks, response, { round: 0, allowSuperseded: false })).toThrow();
  });
});

describe("辅助解析", () => {
  it("字数要求支持约N字、区间与N字左右", () => {
    expect(parseTaskCharacterTarget("（约100字）")).toMatchObject({ minimum: 70, maximum: 130 });
    expect(parseTaskCharacterTarget("建议字数：100-150字")).toMatchObject({ minimum: 70, maximum: 195 });
    expect(parseTaskCharacterTarget("200字左右")).toMatchObject({ minimum: 140, maximum: 260 });
    expect(parseTaskCharacterTarget("写清楚")).toBeUndefined();
  });

  it("证据忽略标点，可用省略号分多处摘录", () => {
    expect(evidenceAppearsIn("书山有路勤为径……金老师", "“书山有路勤为径。”这句话让我想起了金老师。")).toBe(true);
    expect(evidenceAppearsIn("学海无涯", "书山有路勤为径。")).toBe(false);
  });
});

/** 家奇 2026-11-05 订正后的作业配置文案（线上已同步）。 */
const ZHX_REQUIREMENTS_REVISED = ZHX_REQUIREMENTS
  .replace("要求： 使用名人名言引入；埋下“抑”的伏笔或设置悬念；点出特定人物。", "要求： 使用名人名言引入，并简短解释名言；点出特定人物；可用一句话过渡（点到即可，不在本段展开“抑”）。")
  .replace("呼应开头的环境元素并赋予新的情感意义", "呼应前文并赋予新的情感意义");

describe("家奇订正：文案与返修意见", () => {
  const essay = [han(100), han(100), han(200), han(100), han(100)];

  it("订正后的配置：第一段不再要求埋抑的伏笔，第五段只要求呼应前文", () => {
    const tasks = parseStructureTasks(ZHX_REQUIREMENTS_REVISED, 5)!;
    expect(tasks[0]!.elements).toContain("使用名人名言引入，并简短解释名言");
    expect(tasks[0]!.elements.filter((item) => !tasks[0]!.systemRules.includes(item)).some((item) => item.includes("伏笔"))).toBe(false);
    expect(tasks[0]!.elements).toContain(OPENING_NO_SUPPRESSION_ELEMENT);
    expect(describeStructureTask(tasks[0]!)).not.toContain(OPENING_FORESHADOW_NOTE);
    expect(tasks[4]!.elements).toContain("呼应前文并赋予新的情感意义");
    expect(tasks[4]!.elements.join("")).not.toContain("环境元素");
  });

  it("复核口径：呼应前文不强制环境；不提前写真相允许一句过渡", () => {
    const prompt = structureAuditPrompt(parseStructureTasks(ZHX_REQUIREMENTS_REVISED, 5)!, "", false);
    expect(prompt).toContain("“呼应前文”要求前文确实有被呼应的内容");
    expect(prompt).not.toContain("呼应开头的环境元素");
    expect(NO_LEAK_ELEMENT).toContain("允许一句过渡或点到");
    expect(NO_LEAK_ELEMENT).toContain("禁止成段或两句以上");
  });

  it("第一段功能要素是限定性要求：met 时不要求摘抄原句（李妍霖案例）", () => {
    const tasks = parseStructureTasks(ZHX_REQUIREMENTS, 5)!;
    const response = reply(tasks, essay);
    const functionId = tasks[0]!.elements.indexOf(OPENING_FUNCTION_ELEMENT) + 1;
    response.paragraphs[0]!.elements.find((item) => item.id === functionId)!.evidence = "无";
    expect(judgeStructureAudit(essay, tasks, response, { round: 0, allowSuperseded: false }).passed).toBe(true);
  });

  it("配置允许生活化场景引入时，第一段功能要素不强制名言", () => {
    const scene = ZHX_REQUIREMENTS.replace("使用名人名言引入", "使用生活化场景或名人名言引入");
    const tasks = parseStructureTasks(scene, 5)!;
    expect(tasks[0]!.systemRules[0]).toBe(OPENING_FUNCTION_SCENE_ELEMENT);
  });

  it("返修意见逐条带要求、问题类型、复核原句/缺口、改法和当前正文", () => {
    const tasks = parseStructureTasks(ZHX_REQUIREMENTS_REVISED, 5)!;
    const bad = [han(100), han(100), han(200), han(100), han(40)];
    const response = reply(tasks, bad, { 3: [NO_LEAK_ELEMENT], 5: ["呼应前文并赋予新的情感意义"] });
    const round = judgeStructureAudit(bad, tasks, response, { round: 0, allowSuperseded: false });
    const feedback = structureRepairFeedback(round, bad, tasks);
    expect(feedback.map((item) => item.paragraph)).toEqual([3, 5]);
    expect(feedback[0]).toMatchObject({ currentText: bad[2], actualHanCharacters: 200, allowedHanCharacters: "140-260" });
    expect(feedback[0]!.issues).toEqual([expect.objectContaining({ requirement: NO_LEAK_ELEMENT, problem: "violation", auditorNote: "违规原句" })]);
    expect(feedback[1]!.task).toContain("呼应前文");
    expect(feedback[1]!.issues.map((item) => item.problem)).toEqual(["missing", "length"]);
    expect(feedback[1]!.issues[1]!.fix).toBe("扩写到 70-130 个汉字");
    expect(structureFailureCount(round)).toBe(3);
  });

  it("met 但正文找不到证据时，返修意见指出找不到的句子", () => {
    const tasks = parseStructureTasks(ZHX_REQUIREMENTS_REVISED, 5)!;
    const response = reply(tasks, essay, {}, { 2: "不存在的句子" });
    const round = judgeStructureAudit(essay, tasks, response, { round: 0, allowSuperseded: false });
    const [item] = structureRepairFeedback(round, essay, tasks);
    expect(item!.paragraph).toBe(2);
    expect(item!.issues[0]).toMatchObject({ problem: "no_evidence", auditorNote: expect.stringContaining("不存在的句子") });
  });
});
