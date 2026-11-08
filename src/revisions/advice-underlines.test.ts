import { describe, expect, it } from "vitest";

import { collapseParagraphSuggestions } from "../domain/paragraph-actions";
import { paragraphReviewSchema } from "../domain/contracts";
import {
  adviceUnderlineStyle,
  buildAdviceRevisionRuns,
  locateRevisedQuotes,
  sanitizeRevisedQuotes,
  splitParagraphActions,
} from "./advice-underlines";

// 样例图（家奇 2026-11-05）：三条修改动作 → 波浪 / 双线 / 单线。
const SOURCE = "下课后，李老师把我叫到办公室。他问我是不是不舒服。我说没事。";
const REVISED = "下课后，李老师把我叫到办公室。他柔声问我是不是不舒服，我心头一颤，眼睛有些湿润。"
  + "一缕夕阳透过窗户斜斜地洒进来，照在他那件旧衬衫上。我被深深感动，这样的老师我之前一直没有见过。";
const ADVICE = "1. 在老师询问时加入“我”的心理描写。\n2. 增加暖色调环境描写，如“夕阳透过窗户洒进来，照在旧衬衫上”，烘托转折。\n3. 增加一段转折，写清楚我情感转变。";
const QUOTES = [
  "我心头一颤，",
  "一缕夕阳透过窗户斜斜地洒进来，照在他那件旧衬衫上。",
  "我被深深感动，这样的老师我之前一直没有见过。",
];

function joined(runs: { text: string }[]) {
  return runs.map((run) => run.text).join("");
}

describe("splitParagraphActions", () => {
  it("把分行编号的 advice 拆成逐条", () => {
    expect(splitParagraphActions(ADVICE)).toEqual([
      "在老师询问时加入“我”的心理描写。",
      "增加暖色调环境描写，如“夕阳透过窗户洒进来，照在旧衬衫上”，烘托转折。",
      "增加一段转折，写清楚我情感转变。",
    ]);
  });

  it("容忍同一行编号与全角、顿号编号", () => {
    expect(splitParagraphActions("1、补心理。 2．补环境。3）补转折。")).toEqual(["补心理。", "补环境。", "补转折。"]);
  });

  it("不是编号列表时整段算一条；本段无需修改算零条", () => {
    expect(splitParagraphActions("写清迈步的感觉，把动作放慢。")).toEqual(["写清迈步的感觉，把动作放慢。"]);
    expect(splitParagraphActions("把字数扩到 1.5 倍")).toEqual(["把字数扩到 1.5 倍"]);
    expect(splitParagraphActions("本段无需修改")).toEqual([]);
  });

  it("编号不从 1 起或不连续时不拆", () => {
    expect(splitParagraphActions("2. 补环境。\n3. 补转折。")).toHaveLength(1);
    expect(splitParagraphActions("先补环境，见第 1. 条")).toHaveLength(1);
  });
});

describe("adviceUnderlineStyle", () => {
  it("波浪、双线、单线循环", () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(adviceUnderlineStyle)).toEqual([
      "wave", "double", "single", "wave", "double", "single", "wave",
    ]);
  });
});

describe("buildAdviceRevisionRuns", () => {
  it("按样例图把三条动作对应句分别标成波浪、双线、单线，未改动句不划线", () => {
    const runs = buildAdviceRevisionRuns(SOURCE, REVISED, [{ advice: ADVICE, revisedQuotes: QUOTES }]);
    expect(joined(runs)).toBe(REVISED);
    expect(runs.filter((run) => run.kind === "inserted")).toEqual([
      { kind: "inserted", text: QUOTES[0], underline: "wave", actionIndex: 0 },
      { kind: "inserted", text: QUOTES[1], underline: "double", actionIndex: 1 },
      { kind: "inserted", text: QUOTES[2], underline: "single", actionIndex: 2 },
    ]);
    expect(runs[0]).toEqual({ kind: "unchanged", text: "下课后，李老师把我叫到办公室。他柔声问我是不是不舒服，" });
  });

  it("摘录顺序与在正文里的位置不同也按动作序号定线型", () => {
    const runs = buildAdviceRevisionRuns(SOURCE, REVISED, [{
      advice: "1. 增加转折。\n2. 加心理描写。",
      revisedQuotes: [QUOTES[2]!, QUOTES[0]!],
    }]);
    expect(joined(runs)).toBe(REVISED);
    expect(runs.filter((run) => run.kind === "inserted").map((run) => [run.text, run.underline])).toEqual([
      [QUOTES[0], "double"],
      [QUOTES[2], "wave"],
    ]);
  });

  it("超过 3 条从头循环；空摘录占序号但不划线", () => {
    const revised = "甲句。乙句。丙句。丁句。戊句。";
    const runs = buildAdviceRevisionRuns("", revised, [{
      advice: "1. 一\n2. 二\n3. 删去重复句\n4. 四\n5. 五",
      revisedQuotes: ["甲句。", "乙句。", "", "丁句。", "戊句。"],
    }]);
    expect(runs.filter((run) => run.kind === "inserted").map((run) => run.underline)).toEqual([
      "wave", "double", "wave", "double",
    ]);
    expect(runs.find((run) => run.text === "丙句。")?.kind).toBe("unchanged");
  });

  it("多条 suggestion 合并编号后同样拆条映射", () => {
    const runs = buildAdviceRevisionRuns(SOURCE, REVISED, [
      { advice: "加入心理描写", revisedQuotes: [QUOTES[0]!] },
      { advice: "增加环境描写", revisedQuotes: [QUOTES[1]!] },
    ]);
    expect(runs.filter((run) => run.kind === "inserted").map((run) => run.underline)).toEqual(["wave", "double"]);
  });

  it("旧报告没有摘录时退回：相对原文改动的句子一律单线", () => {
    const runs = buildAdviceRevisionRuns("我慢慢走上台。灯光很亮。", "我终于走上台。灯光很亮。我听见自己的呼吸。", [
      { advice: "写清迈步的感觉" },
    ]);
    expect(runs).toEqual([
      { kind: "inserted", text: "我终于走上台。", underline: "single" },
      { kind: "unchanged", text: "灯光很亮。" },
      { kind: "inserted", text: "我听见自己的呼吸。", underline: "single" },
    ]);
  });

  it("教师改过正文导致摘录找不到、或摘录条数与动作数不符时退回单线", () => {
    const stale = buildAdviceRevisionRuns(SOURCE, REVISED.replace("心头一颤", "心里一暖"), [
      { advice: ADVICE, revisedQuotes: QUOTES },
    ]);
    expect(stale.every((run) => run.kind !== "inserted" || run.underline === "single")).toBe(true);
    expect(stale.some((run) => run.kind === "inserted")).toBe(true);

    const mismatch = buildAdviceRevisionRuns(SOURCE, REVISED, [
      { advice: "1. 加心理。\n2. 加环境。", revisedQuotes: QUOTES },
    ]);
    expect(mismatch.every((run) => run.kind !== "inserted" || run.underline === "single")).toBe(true);
  });

  it("多条 suggestion 中有一条缺摘录时整段退回单线", () => {
    const runs = buildAdviceRevisionRuns(SOURCE, REVISED, [
      { advice: "加心理", revisedQuotes: [QUOTES[0]!] },
      { advice: "加环境" },
    ]);
    expect(runs.every((run) => run.kind !== "inserted" || run.underline === "single")).toBe(true);
  });

  it("本段无需修改且摘录为空时不划线，即使正文顺手改了错字标点", () => {
    const runs = buildAdviceRevisionRuns("我以前总觉的这句话离自已很远", "我以前总觉得这句话离自己很远。", [
      { advice: "本段无需修改", revisedQuotes: [] },
    ]);
    expect(runs).toEqual([{ kind: "unchanged", text: "我以前总觉得这句话离自己很远。" }]);
  });

  it("只有删除动作（摘录为空串）时可靠但无句可划，不退回整段单线", () => {
    const runs = buildAdviceRevisionRuns("天很阴。我差点错过她的好。她笑了。", "天很阴。她笑了。", [
      { advice: "删去原文提前揭示情感转折的一句", revisedQuotes: [""] },
    ]);
    expect(runs.every((run) => run.kind === "unchanged")).toBe(true);
    expect(joined(runs)).toBe("天很阴。她笑了。");
  });

  it("退回单线时，只改错字语病标点、与原文意思基本相同的句子不划", () => {
    const source = "法国罗丹说过生活中不是缺少美而是缺少发现美的眼晴。我以前总觉的这句话离自已很远。";
    const revised = "法国罗丹说过：“生活中不是缺少美，而是缺少发现美的眼睛。”我以前总觉得这句话离自己很远。直到我真正注意到英语老师，我才发现，原来我对她的了解是那么少。";
    const runs = buildAdviceRevisionRuns(source, revised, [{ advice: "简单解释和点出英语老师" }]);
    expect(runs.filter((run) => run.kind === "inserted").map((run) => run.text)).toEqual([
      "直到我真正注意到英语老师，我才发现，原来我对她的了解是那么少。",
    ]);
    expect(joined(runs)).toBe(revised);
  });

  it("相同摘录出现两次时取不重叠的下一处", () => {
    const ranges = locateRevisedQuotes("好。好。", [{ advice: "1. 一\n2. 二", revisedQuotes: ["好。", "好。"] }]);
    expect(ranges?.map(({ start, end }) => [start, end])).toEqual([[0, 2], [2, 4]]);
  });
});

describe("sanitizeRevisedQuotes", () => {
  const review = {
    paragraphId: "paragraph-1",
    suggestions: [{ advice: ADVICE, revisedQuotes: QUOTES }],
    revisedText: REVISED,
  };

  it("摘录全部能在改后全段逐字定位时原样保留", () => {
    expect(sanitizeRevisedQuotes(review)).toBe(review);
  });

  it("摘录不是逐字子串时只删摘录，其他字段不变", () => {
    const bad = { ...review, suggestions: [{ advice: ADVICE, revisedQuotes: ["我心里一颤", QUOTES[1]!, QUOTES[2]!] }] };
    expect(sanitizeRevisedQuotes(bad)).toEqual({ ...review, suggestions: [{ advice: ADVICE }] });
  });

  it("没有摘录的旧数据原样返回", () => {
    const legacy = { ...review, suggestions: [{ advice: ADVICE }] };
    expect(sanitizeRevisedQuotes(legacy)).toBe(legacy);
  });
});

describe("schema 与合并", () => {
  it("paragraphReviewSchema 接受可选 revisedQuotes，旧报告不带也通过", () => {
    expect(paragraphReviewSchema.parse({
      paragraphId: "paragraph-1",
      suggestions: [{ advice: ADVICE, revisedQuotes: QUOTES }],
      revisedText: REVISED,
    }).suggestions[0]?.revisedQuotes).toEqual(QUOTES);
    expect(paragraphReviewSchema.parse({
      paragraphId: "paragraph-1",
      suggestions: [{ advice: ADVICE }],
      revisedText: REVISED,
    }).suggestions[0]?.revisedQuotes).toBeUndefined();
  });

  it("collapseParagraphSuggestions 合并编号时按顺序拼接摘录；有缺失则不带", () => {
    expect(collapseParagraphSuggestions([
      { advice: "加心理", revisedQuotes: ["甲"] },
      { advice: "加环境", revisedQuotes: ["乙"] },
    ])).toEqual([{ advice: "1. 加心理\n2. 加环境", revisedQuotes: ["甲", "乙"] }]);
    expect(collapseParagraphSuggestions([
      { advice: "加心理", revisedQuotes: ["甲"] },
      { advice: "加环境" },
    ])).toEqual([{ advice: "1. 加心理\n2. 加环境" }]);
  });
});
