import { describe, expect, it } from "vitest";
import {
  composeReviewGuidance,
  ESSAY_REQUIREMENTS_PRECEDENCE,
  guidanceForPrompt,
  mergeEssayRequirements,
  normalizeRequirement,
  readReviewGuidance,
  shanghaiDate,
  splitRequirementSentences,
} from "./review-guidance";
import { validateTeacherRewriteLengths } from "../domain/teacher-rewrite-lengths";

const at = (beijing: string) => Date.parse(`${beijing.replace(" ", "T")}+08:00`);

/** 章皓轩（review 936a7915-e18d-4e49-bb8a-0abcb848e4d0）的真实本篇意见，按数据库顺序（新→旧）。 */
const zhangHaoxuan = [
  { text: "这个主人公是数学老师，男的，姓金。时间是请他们吃炸鸡\n这个老师是数学老师，金老师\n名人名言不合适，字数不够", createdAt: at("2026-11-05 10:14:01") },
  { text: "这个主人公是数学老师，男的，姓金。时间是请他们吃炸鸡\n这个老师是数学老师，金老师\n名人名言不合适", createdAt: at("2026-11-05 10:01:58") },
  { text: "这个主人公是数学老师，男的，姓金。时间是请他们吃炸鸡", createdAt: at("2026-10-28 15:57:35") },
  { text: "这个老师是数学老师，金老师", createdAt: at("2026-10-28 15:32:32") },
  { text: "名人名言不合适", createdAt: at("2026-10-28 15:32:32") },
];

const luLuoming = [
  { text: "不要在文章中加入无用的细节，比如“邋遢”。把这篇文章的核心事件改为：爸爸忘性大，这次没及时来接我很伤心，觉得爸爸不爱我；跟妈妈讲了之后，妈妈告诉我爸爸很爱我，那天真的很忙，我的每一件事他都会专门记下来；结尾我收到爸爸的道歉礼物。字数不太够，内心转变太快，前后文有些跳脱。名人名言用的不合适。", createdAt: at("2026-11-02 09:20:00") },
  { text: "写得事件太多了，只写一件事，就是忘了接我，我很伤心。但是后面妈妈给我解释，爸爸给我道歉", createdAt: at("2026-10-29 16:05:10") },
];

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe("本篇意见合并", () => {
  it("按换行与句末标点拆句，规范化统一全半角并去掉空白标点", () => {
    expect(splitRequirementSentences("甲。乙！丙？丁；戊\n己\n[内容建议]\n庚")).toEqual(["甲。", "乙！", "丙？", "丁；", "戊", "己", "庚"]);
    expect(normalizeRequirement("名人名言 不合适，")).toBe(normalizeRequirement("名人名言不合适,"));
    expect(normalizeRequirement("第１段ＡＢ")).toBe(normalizeRequirement("第1段ab"));
    expect(shanghaiDate(at("2026-11-05 00:30:00"))).toBe("2026-11-05");
    expect(shanghaiDate(0)).toBe("日期未知");
  });

  it("章皓轩：重复与被包含的旧句只保留最新一次，每条各出现一次并带北京时间日期", () => {
    const merged = mergeEssayRequirements(zhangHaoxuan);
    expect(merged.items.map(({ date, text }) => `${date} ${text}`)).toEqual([
      "2026-11-05 这个主人公是数学老师，男的，姓金。",
      "2026-11-05 时间是请他们吃炸鸡",
      "2026-11-05 这个老师是数学老师，金老师",
      "2026-11-05 名人名言不合适，字数不够",
    ]);
    expect(merged.omitted).toBe(0);
    const prompt = guidanceForPrompt(composeReviewGuidance(null, [], zhangHaoxuan));
    expect(occurrences(prompt, "姓金")).toBe(1);
    expect(occurrences(prompt, "炸鸡")).toBe(1);
    expect(occurrences(prompt, "金老师")).toBe(1);
    expect(occurrences(prompt, "名人名言不合适")).toBe(1);
    expect(prompt).toContain("名人名言不合适，字数不够");
    expect(prompt).toContain(ESSAY_REQUIREMENTS_PRECEDENCE);
    expect(prompt).not.toContain("仅作上下文，与本篇");
  });

  it("陆骆鸣：两次不同日期的不同意见全部保留", () => {
    const merged = mergeEssayRequirements(luLuoming);
    const text = merged.items.map(({ text }) => text).join("");
    expect(merged.items[0].date).toBe("2026-10-29");
    expect(merged.items.at(-1)!.date).toBe("2026-11-02");
    expect(merged.deduplicated + merged.superseded + merged.omitted).toBe(0);
    for (const sentence of [
      "写得事件太多了，只写一件事，就是忘了接我，我很伤心。",
      "但是后面妈妈给我解释，爸爸给我道歉",
      "不要在文章中加入无用的细节，比如“邋遢”。",
      "我的每一件事他都会专门记下来；",
      "结尾我收到爸爸的道歉礼物。",
      "字数不太够，内心转变太快，前后文有些跳脱。",
      "名人名言用的不合适。",
    ]) expect(text).toContain(sentence);
  });

  it("同段同类可判定冲突（段数、字数上下限）保留最新，其余保留", () => {
    const merged = mergeEssayRequirements([
      { text: "四段式，第1段最多20字", createdAt: at("2026-11-03 10:00:00") },
      { text: "五段式。第1段至少100字。结尾点题", createdAt: at("2026-11-01 10:00:00") },
      { text: "第2段至少80字", createdAt: at("2026-11-01 10:00:00") },
    ]);
    const texts = merged.items.map(({ text }) => text);
    expect(texts).not.toContain("五段式。");
    expect(texts).toContain("第1段至少100字。");
    expect(texts).toContain("第2段至少80字");
    expect(texts).toContain("结尾点题");
    expect(texts).toContain("四段式，第1段最多20字");
    expect(merged.superseded).toBe(1);
  });

  it("本轮已写的句子不在历史层重复，本轮排在最后作为最新", () => {
    const raw = composeReviewGuidance("[内容建议]\n名人名言不合适，字数不够", [], zhangHaoxuan, { now: at("2026-11-05 11:00:00") })!;
    const layers = readReviewGuidance(raw);
    expect(raw.startsWith("review-guidance-v2:")).toBe(true);
    expect(layers.history).not.toContain("名人名言");
    expect(layers.history).toContain("[2026-11-05] 这个老师是数学老师，金老师");
    const prompt = guidanceForPrompt(raw);
    expect(prompt.indexOf("[本篇有效要求")).toBeLessThan(prompt.indexOf("[本轮要求（2026-11-05，最新）]"));
    expect(prompt.trimEnd().endsWith("名人名言不合适，字数不够")).toBe(true);
  });

  it("超出预算时先合并重复，再删最早整句，绝不切半句并记录删减条数", () => {
    const history = Array.from({ length: 30 }, (_, index) => ({
      text: `第${(index % 9) + 1}段补充细节${index}号：${"写清楚动作和心情".repeat(5)}。`,
      createdAt: at("2026-10-01 08:00:00") + index * 86_400_000,
    }));
    const raw = composeReviewGuidance("本轮要求", [], [...history, ...history], { maxChars: 1500 })!;
    const layers = readReviewGuidance(raw);
    const lines = layers.history.split("\n");
    expect(layers.omitted).toBeGreaterThan(0);
    expect(lines.length + layers.omitted).toBe(30);
    for (const line of lines) expect(line).toMatch(/^\[\d{4}-\d{2}-\d{2}\] 第\d段补充细节\d+号：(?:写清楚动作和心情){5}。$/u);
    expect(lines.at(-1)).toContain("29号");
    expect(guidanceForPrompt(raw)).toContain(`已省略最早的 ${layers.omitted} 条`);
    expect(layers.current).toBe("本轮要求");
  });
});

describe("分层指导", () => {
  it("硬约束只解析本轮；历史层全部有效，交给模型按日期取舍", () => {
    const standing = [{ text: "五段式，第1段至少100字", createdAt: 1 }];
    const history = [
      { text: "五段式，第1段至少100字，结尾点题", createdAt: at("2026-10-01 10:00:00") },
      { text: "四段式，第1段最多20字，结尾写动作", createdAt: at("2026-10-02 10:00:00") },
    ];
    const raw = composeReviewGuidance("严格三段式，第1段最多5字，结尾留白", standing, history)!;
    expect(readReviewGuidance(raw).constraints).toBe("严格三段式，第1段最多5字，结尾留白");
    expect(() => validateTeacherRewriteLengths(["甲乙", "丙", "丁"], readReviewGuidance(raw).constraints)).not.toThrow();
    const batch = readReviewGuidance(composeReviewGuidance(null, standing, history));
    expect(batch.constraints).toBe("");
    expect(batch.history).toContain("[2026-10-01] 五段式，第1段至少100字，结尾点题");
    expect(batch.history).toContain("[2026-10-02] 四段式，第1段最多20字，结尾写动作");
    expect(guidanceForPrompt(raw)).toContain("同一事项前后矛盾时以日期较新的为准");
    expect(guidanceForPrompt(raw)).toContain("与本轮要求同等有效");
    expect(readReviewGuidance(composeReviewGuidance(null, standing, [])).history).toBe("");
  });

  it("完整保留最长本轮文本，并容忍教师手写的标记前缀", () => {
    const current = "甲".repeat(4000);
    const raw = composeReviewGuidance(current, [], [])!;
    expect(readReviewGuidance(raw).current).toBe(current);
    expect(readReviewGuidance("review-guidance-v1:不是JSON").current).toBe("review-guidance-v1:不是JSON");
    expect(readReviewGuidance("review-guidance-v2:不是JSON").current).toBe("review-guidance-v2:不是JSON");
  });

  it("本篇历史不再按字截断", () => {
    const longOpinion = `${"把核心事件写具体".repeat(400)}。`;
    const raw = composeReviewGuidance("本轮".repeat(1200), [{ text: "长期".repeat(1000), createdAt: 1 }], [{ text: longOpinion, createdAt: at("2026-11-01 10:00:00") }])!;
    expect(readReviewGuidance(raw).current).toBe("本轮".repeat(1200));
    expect(readReviewGuidance(raw).history).toBe(`[2026-11-01] ${longOpinion}`);
  });

  it("兼容已存的 review-guidance-v1 数据", () => {
    const v1 = `review-guidance-v1:${JSON.stringify({ current: "本轮写三段", history: "名人名言不合适", standing: "" })}`;
    const layers = readReviewGuidance(v1);
    expect(layers).toMatchObject({ current: "本轮写三段", history: "名人名言不合适", standing: "", constraints: "本轮写三段", format: "v1", omitted: 0 });
    const prompt = guidanceForPrompt(v1);
    expect(prompt).toContain("[本篇历史要求（旧格式，无日期）");
    expect(prompt).toContain("名人名言不合适");
    expect(prompt.indexOf("名人名言不合适")).toBeLessThan(prompt.indexOf("本轮写三段"));
  });
});
