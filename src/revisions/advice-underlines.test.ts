import { describe, expect, it } from "vitest";

import { collapseParagraphSuggestions } from "../domain/paragraph-actions";
import { paragraphReviewSchema } from "../domain/contracts";
import {
  adviceActionUnderlines,
  adviceUnderlineStyle,
  buildAdviceRevisionRuns,
  effectiveQuoteRanges,
  locateRevisedQuotes,
  paintQuoteRange,
  rangesToPersistedRanges,
  rangesToRevisedQuotes,
  reconcileQuotesOnAdviceChange,
  reconcileQuotesOnRevisedTextChange,
  sanitizeRevisedQuotes,
  splitParagraphActions,
  splitParagraphActionSlices,
  splitRevisedSentences,
  validateQuoteRangesCapacity,
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
  it("按手改稿：单线、波浪线、点划线循环", () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(adviceUnderlineStyle)).toEqual([
      "single", "wave", "dotDotDash", "single", "wave", "dotDotDash", "single",
    ]);
  });
});

describe("buildAdviceRevisionRuns", () => {
  it("三条动作对应句分别标成单线、波浪线、点划线，未改动句不划线", () => {
    const runs = buildAdviceRevisionRuns(SOURCE, REVISED, [{ advice: ADVICE, revisedQuotes: QUOTES }]);
    expect(joined(runs)).toBe(REVISED);
    expect(runs.filter((run) => run.kind === "inserted")).toEqual([
      { kind: "inserted", text: QUOTES[0], underline: "single", actionIndex: 0 },
      { kind: "inserted", text: QUOTES[1], underline: "wave", actionIndex: 1 },
      { kind: "inserted", text: QUOTES[2], underline: "dotDotDash", actionIndex: 2 },
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
      [QUOTES[0], "wave"],
      [QUOTES[2], "single"],
    ]);
  });

  it("超过 3 条从头循环；空摘录占序号但不划线", () => {
    const revised = "甲句。乙句。丙句。丁句。戊句。";
    const runs = buildAdviceRevisionRuns("", revised, [{
      advice: "1. 一\n2. 二\n3. 删去重复句\n4. 四\n5. 五",
      revisedQuotes: ["甲句。", "乙句。", "", "丁句。", "戊句。"],
    }]);
    expect(runs.filter((run) => run.kind === "inserted").map((run) => run.underline)).toEqual([
      "single", "wave", "single", "wave",
    ]);
    expect(runs.find((run) => run.text === "丙句。")?.kind).toBe("unchanged");
  });

  it("多条 suggestion 合并编号后同样拆条映射", () => {
    const runs = buildAdviceRevisionRuns(SOURCE, REVISED, [
      { advice: "加入心理描写", revisedQuotes: [QUOTES[0]!] },
      { advice: "增加环境描写", revisedQuotes: [QUOTES[1]!] },
    ]);
    expect(runs.filter((run) => run.kind === "inserted").map((run) => run.underline)).toEqual(["single", "wave"]);
  });

  it("一条动作落在不相邻的几处时，几处都划同一种线", () => {
    const revised = "推开门时，冷雨停了。她笑了笑。阳光暖暖地照进来。";
    const runs = buildAdviceRevisionRuns("我推开门。她笑了笑。", revised, [{
      advice: "1. 段首加过渡\n2. 增加雨停、阳光照进来的环境描写",
      revisedQuotes: ["", ["推开门时，冷雨停了。", "阳光暖暖地照进来。"]],
    }]);
    expect(joined(runs)).toBe(revised);
    expect(runs.filter((run) => run.kind === "inserted").map((run) => [run.text, run.underline])).toEqual([
      ["推开门时，冷雨停了。", "wave"],
      ["阳光暖暖地照进来。", "wave"],
    ]);
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

describe("adviceActionUnderlines", () => {
  it("有落实句的动作与落实句同线型；删除动作和摘录不可靠时不划线", () => {
    expect(adviceActionUnderlines(REVISED, [{ advice: ADVICE, revisedQuotes: QUOTES }]))
      .toEqual(["single", "wave", "dotDotDash"]);
    expect(adviceActionUnderlines(REVISED, [{ advice: "1. 删去重复句\n2. 加环境", revisedQuotes: ["", QUOTES[1]!] }]))
      .toEqual([null, "wave"]);
    expect(adviceActionUnderlines(REVISED, [{ advice: ADVICE }])).toEqual([null, null, null]);
    expect(adviceActionUnderlines(REVISED, [{ advice: "本段无需修改", revisedQuotes: [] }])).toEqual([]);
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

describe("手动编辑标线与多格式切分辅助函数", () => {
  it("splitParagraphActionSlices 无损还原顿号、右括号、同行多条及单条编号，且不误拆小数", () => {
    const weird = "1、补心理； \n2）补环境。 3. 补转折";
    const slices = splitParagraphActionSlices(weird);
    expect(slices).toEqual([
      { prefix: "1、", body: "补心理；", suffix: " \n" },
      { prefix: "2）", body: "补环境。", suffix: " " },
      { prefix: "3. ", body: "补转折", suffix: "" },
    ]);
    expect(slices.map((item) => item.prefix + item.body + item.suffix).join("")).toBe(weird);

    expect(splitParagraphActionSlices("1. 只改名言引入。")).toEqual([
      { prefix: "1. ", body: "只改名言引入。", suffix: "" },
    ]);
    expect(splitParagraphActionSlices("1.5 倍扩写")).toEqual([
      { prefix: "", body: "1.5 倍扩写", suffix: "" },
    ]);
    expect(splitParagraphActions("1.5 倍至 2.5 倍")).toEqual(["1.5 倍至 2.5 倍"]);
    expect(splitParagraphActionSlices("1.5 倍至 2.5 倍")).toEqual([
      { prefix: "", body: "1.5 倍至 2.5 倍", suffix: "" },
    ]);
    expect(splitParagraphActions("1. ")).toEqual([]);
    expect(splitParagraphActionSlices("1. ")).toEqual([]);
    expect(splitParagraphActionSlices("本段无需修改")).toEqual([]);
  });

  it("revisedRanges 精确区分同段重复短语，消除后处匹配到前处或子串遮蔽整段回退", () => {
    const dup = "甲。甲。";
    const rangesDup = paintQuoteRange(dup, [], 2, 4, 0, 1);
    const suggestionDup = {
      advice: "加强第二句语气",
      revisedQuotes: rangesToRevisedQuotes(dup, rangesDup, 1),
      revisedRanges: rangesToPersistedRanges(dup, rangesDup, 1),
    };
    expect(paragraphReviewSchema.safeParse({
      paragraphId: "paragraph-1",
      suggestions: [suggestionDup],
      revisedText: dup,
    }).success).toBe(true);
    expect(buildAdviceRevisionRuns("", dup, [suggestionDup])).toEqual([
      { kind: "unchanged", text: "甲。" },
      { kind: "inserted", text: "甲。", underline: "single", actionIndex: 0 },
    ]);

    const rain = "小雨停了，小雨。";
    let rainRanges = paintQuoteRange(rain, [], 5, 7, 0, 2);
    rainRanges = paintQuoteRange(rain, rainRanges, 0, 4, 1, 2);
    const suggestionRain = {
      advice: "1. 结尾回扣小雨\n2. 开头点出雨停",
      revisedQuotes: rangesToRevisedQuotes(rain, rainRanges, 2),
      revisedRanges: rangesToPersistedRanges(rain, rainRanges, 2),
    };
    expect(adviceActionUnderlines(rain, [suggestionRain])).toEqual(["single", "wave"]);
    expect(buildAdviceRevisionRuns("", rain, [suggestionRain])).toEqual([
      { kind: "inserted", text: "小雨停了", underline: "wave", actionIndex: 1 },
      { kind: "unchanged", text: "，" },
      { kind: "inserted", text: "小雨", underline: "single", actionIndex: 0 },
      { kind: "unchanged", text: "。" },
    ]);
  });

  it("单条 1. 甲 扩展为多条、改成同名动作或整段首尾粘贴替换时，保留有效标线且不误判调序", () => {
    const singleNumbered = [{
      advice: "1. 加入心理描写",
      revisedQuotes: [QUOTES[0]!],
      revisedRanges: rangesToPersistedRanges(REVISED, [{ start: REVISED.indexOf(QUOTES[0]!), end: REVISED.indexOf(QUOTES[0]!) + QUOTES[0]!.length, actionIndex: 0 }], 1),
    }];
    const expanded = reconcileQuotesOnAdviceChange(REVISED, singleNumbered, "1. 加入心理描写\n2. 增加环境描写");
    expect(expanded.revisedQuotes).toEqual([QUOTES[0]!, ""]);

    const twoDistinct = [{
      advice: "1. 甲动作\n2. 乙动作",
      revisedQuotes: [QUOTES[0]!, QUOTES[1]!],
    }];
    const duplicatedName = reconcileQuotesOnAdviceChange(REVISED, twoDistinct, "1. 乙动作\n2. 乙动作");
    expect(duplicatedName.revisedQuotes).toEqual([QUOTES[0]!, QUOTES[1]!]);

    // 整段粘贴同时修改首句和尾句，中间未改的划线句保持原标线
    const beforePaste = "甲。风停了。乙。";
    const afterPaste = "丙。风停了。丁。";
    const pasted = reconcileQuotesOnRevisedTextChange(beforePaste, afterPaste, [{
      advice: "补写环境描写",
      revisedQuotes: ["风停了。"],
      revisedRanges: [{ start: 2, end: 6, actionIndex: 0, text: "风停了。" }],
    }]);
    expect(pasted[0]?.revisedQuotes).toEqual(["风停了。"]);
    expect(pasted[0]?.revisedRanges).toEqual([{ start: 2, end: 6, actionIndex: 0, text: "风停了。" }]);
  });

  it("支持同一动作 17 处以上非相邻标线及超长含 emoji 段落按完整码点切块", () => {
    const chars = Array.from({ length: 17 }, (_, idx) => `第${idx + 1}处`).join("，");
    let manyRanges: ReturnType<typeof paintQuoteRange> = [];
    let searchCursor = 0;
    for (let idx = 0; idx < 17; idx += 1) {
      const token = `第${idx + 1}处`;
      const pos = chars.indexOf(token, searchCursor);
      manyRanges = paintQuoteRange(chars, manyRanges, pos, pos + token.length, 0, 1);
      searchCursor = pos + token.length;
    }
    const quotes17 = rangesToRevisedQuotes(chars, manyRanges, 1);
    const persisted17 = rangesToPersistedRanges(chars, manyRanges, 1);
    expect(Array.isArray(quotes17[0]) ? quotes17[0] : []).toHaveLength(17);
    expect(persisted17).toHaveLength(17);
    expect(paragraphReviewSchema.safeParse({
      paragraphId: "paragraph-1",
      suggestions: [{ advice: "逐处微调", revisedQuotes: quotes17, revisedRanges: persisted17 }],
      revisedText: chars,
    }).success).toBe(true);

    // 1999 个汉字后紧跟 UTF-16 代理对 emoji 😀，切块绝不产生孤立代理项
    const emojiText = `${"甲".repeat(1999)}😀乙`;
    const emojiQuotes = rangesToRevisedQuotes(emojiText, [{ start: 0, end: emojiText.length, actionIndex: 0 }], 1);
    const flatPieces = emojiQuotes.flatMap((item) => (typeof item === "string" ? [item] : item));
    expect(flatPieces.every((piece) => piece.isWellFormed())).toBe(true);
    expect(flatPieces.join("")).toBe(emojiText);
  });

  it("paintQuoteRange 支持在全段单线回退稿上局部改线型、擦除中间半句与合并同线型相邻片段", () => {
    const revised = "“良言一句三冬暖。”一句温暖贴心的话，能在寒冬里焐热一颗心。我以前却不这么想。那时我最怕数学金老师。";
    const advice = "1. 简单解释名言并点出金老师，加过渡；\n2. 换用贴切名言“良言一句三冬暖”。";
    const initial = effectiveQuoteRanges("原本的一段。", revised, [{ advice }]);
    expect(initial).toEqual([{ start: 0, end: revised.length, actionIndex: 0 }]);

    // 把开头名言改为第 2 条动作（波浪线）
    const quoteEnd = "“良言一句三冬暖。”".length;
    const afterWave = paintQuoteRange(revised, initial, 0, quoteEnd, 1, 2);
    // 把末句擦除标线
    const lastStart = revised.indexOf("那时我最怕数学金老师。");
    const afterErase = paintQuoteRange(revised, afterWave, lastStart, revised.length, null, 2);
    const quotes = rangesToRevisedQuotes(revised, afterErase, 2);
    expect(quotes).toEqual([
      "一句温暖贴心的话，能在寒冬里焐热一颗心。我以前却不这么想。",
      "“良言一句三冬暖。”",
    ]);

    const runs = buildAdviceRevisionRuns("原本的一段。", revised, [{ advice, revisedQuotes: quotes }]);
    expect(runs).toEqual([
      { kind: "inserted", text: "“良言一句三冬暖。”", underline: "wave", actionIndex: 1 },
      { kind: "inserted", text: "一句温暖贴心的话，能在寒冬里焐热一颗心。我以前却不这么想。", underline: "single", actionIndex: 0 },
      { kind: "unchanged", text: "那时我最怕数学金老师。" },
    ]);
  });

  it("reconcileQuotesOnAdviceChange 在增删、前插或调换动作顺序时保留对应摘录，不退回整段单线", () => {
    const suggestions = [{
      advice: "1. 加入心理描写。\n2. 增加暖色调环境描写。",
      revisedQuotes: [QUOTES[0]!, QUOTES[1]!],
    }];

    // 末尾新增第 3 条
    const added = reconcileQuotesOnAdviceChange(
      REVISED,
      suggestions,
      "1. 加入心理描写。\n2. 增加暖色调环境描写。\n3. 增加一段转折。",
    );
    expect(added.revisedQuotes).toEqual([QUOTES[0]!, QUOTES[1]!, ""]);

    // 删除第 1 条并重编号
    const removedFirst = reconcileQuotesOnAdviceChange(
      REVISED,
      suggestions,
      "1. 增加暖色调环境描写。",
    );
    expect(removedFirst.revisedQuotes).toEqual([QUOTES[1]!]);

    // 调换两条顺序
    const swapped = reconcileQuotesOnAdviceChange(
      REVISED,
      suggestions,
      "1. 增加暖色调环境描写。\n2. 加入心理描写。",
    );
    expect(swapped.revisedQuotes).toEqual([QUOTES[1]!, QUOTES[0]!]);

    // 改为无需修改
    const unchanged = reconcileQuotesOnAdviceChange(REVISED, suggestions, "本段无需修改");
    expect(unchanged.revisedQuotes).toEqual([]);
  });

  it("reconcileQuotesOnRevisedTextChange 在划线句内部改字或句外加句时平滑更新摘录", () => {
    const suggestions = [{
      advice: ADVICE,
      revisedQuotes: [...QUOTES],
    }];
    const editedInside = REVISED.replace("心头一颤", "心里一暖");
    const reconciled = reconcileQuotesOnRevisedTextChange(REVISED, editedInside, suggestions);
    expect(reconciled[0]?.revisedQuotes).toEqual([
      "我心里一暖，",
      QUOTES[1]!,
      QUOTES[2]!,
    ]);
    const runs = buildAdviceRevisionRuns(SOURCE, editedInside, reconciled);
    expect(runs.filter((run) => run.kind === "inserted").map((run) => [run.text, run.underline])).toEqual([
      ["我心里一暖，", "single"],
      [QUOTES[1]!, "wave"],
      [QUOTES[2]!, "dotDotDash"],
    ]);

    // 句末追加新句不吞进原第 3 条标线
    const appended = `${editedInside}窗外的风也轻了。`;
    const afterAppend = reconcileQuotesOnRevisedTextChange(editedInside, appended, reconciled);
    expect(afterAppend[0]?.revisedQuotes).toEqual([
      "我心里一暖，",
      QUOTES[1]!,
      QUOTES[2]!,
    ]);
  });

  it("splitRevisedSentences 合并引号尾碎片并精确覆盖全文偏移", () => {
    const text = "“良言一句三冬暖。”一句温暖贴心的话，能在寒冬里焐热一颗心。我以前却不这么想。";
    const spans = splitRevisedSentences(text);
    expect(spans.map((span) => span.text)).toEqual([
      "“良言一句三冬暖。”",
      "一句温暖贴心的话，能在寒冬里焐热一颗心。",
      "我以前却不这么想。",
    ]);
    expect(spans.map((span) => text.slice(span.start, span.end)).join("")).toBe(text);
  });

  it("段首含全角/半角缩进时，revisedRanges 在保存与导出 trim 前后均锚定同一个重复字（M1）", () => {
    const rawIndented = "　甲甲甲";
    const painted = paintQuoteRange(rawIndented, [], 2, 3, 0, 1);
    const suggestion = {
      advice: "强调第二个甲",
      revisedQuotes: rangesToRevisedQuotes(rawIndented, painted, 1),
      revisedRanges: rangesToPersistedRanges(rawIndented, painted, 1),
    };
    // 未 trim 时第 2 个「甲」在索引 [2,3)
    expect(buildAdviceRevisionRuns("", rawIndented, [suggestion])).toEqual([
      { kind: "unchanged", text: "　甲" },
      { kind: "inserted", text: "甲", underline: "single", actionIndex: 0 },
      { kind: "unchanged", text: "甲" },
    ]);
    // 经 paragraphReviewSchema.parse 去掉段首全角空格后，仍精确命中第 2 个「甲」而非移到第 3 个
    const parsed = paragraphReviewSchema.parse({
      paragraphId: "paragraph-1",
      suggestions: [suggestion],
      revisedText: rawIndented,
    });
    expect(parsed.revisedText).toBe("甲甲甲");
    expect(buildAdviceRevisionRuns("", parsed.revisedText, parsed.suggestions)).toEqual([
      { kind: "unchanged", text: "甲" },
      { kind: "inserted", text: "甲", underline: "single", actionIndex: 0 },
      { kind: "unchanged", text: "甲" },
    ]);
  });

  it("仅带历史 revisedQuotes 的报告在调换动作或句首插入重复句时自动升级 revisedRanges 保住原位（M2 & M5）", () => {
    const rain = "小雨停了，小雨。";
    const legacyQuotesOnly = [{
      advice: "1. 写雨停\n2. 呼应小雨",
      revisedQuotes: ["小雨停了", "小雨"],
    }];
    const swapped = reconcileQuotesOnAdviceChange(rain, legacyQuotesOnly, "1. 呼应小雨\n2. 写雨停");
    expect(buildAdviceRevisionRuns("", rain, [swapped])).toEqual([
      { kind: "inserted", text: "小雨停了", underline: "wave", actionIndex: 1 },
      { kind: "unchanged", text: "，" },
      { kind: "inserted", text: "小雨", underline: "single", actionIndex: 0 },
      { kind: "unchanged", text: "。" },
    ]);

    const beforeInsert = "晨。风停了。";
    const afterInsert = "风停了。晨。风停了。";
    const migrated = reconcileQuotesOnRevisedTextChange(beforeInsert, afterInsert, [{
      advice: "补风停",
      revisedQuotes: ["风停了。"],
    }]);
    expect(buildAdviceRevisionRuns("", afterInsert, migrated)).toEqual([
      { kind: "unchanged", text: "风停了。晨。" },
      { kind: "inserted", text: "风停了。", underline: "single", actionIndex: 0 },
    ]);

    // 历史无摘录旧建议清空动作后，写回显式空摘录，导出与预览均不划整段蓝线
    const clearedLegacy = reconcileQuotesOnAdviceChange("春雨落在窗台，花瓣微微颤动。", [{ advice: "旧建议" }], "");
    expect(clearedLegacy).toEqual({ advice: "本段无需修改", revisedQuotes: [] });
    expect(buildAdviceRevisionRuns("我站着。", "春雨落在窗台，花瓣微微颤动。", [clearedLegacy])).toEqual([
      { kind: "unchanged", text: "春雨落在窗台，花瓣微微颤动。" },
    ]);
  });

  it("支持基于选区提示精准删除前一个重复句（M3）、超 6,000 字长段首尾替换（M4）、50,001/20,001 字符契约一致（M6）及 100 条动作解析（m2）", () => {
    // M3: 删除前一个重复句，保留后一句标线
    const dup = "甲。甲。";
    const secondMarked = [{
      advice: "强调后一句",
      revisedQuotes: ["甲。"],
      revisedRanges: [{ start: 2, end: 4, actionIndex: 0, text: "甲。" }],
    }];
    const afterDeleteFirst = reconcileQuotesOnRevisedTextChange(dup, "甲。", secondMarked, { start: 0, end: 2 });
    expect(afterDeleteFirst[0]?.revisedRanges).toEqual([{ start: 0, end: 2, actionIndex: 0, text: "甲。" }]);

    // M4: 新旧长度之和 > 6,000 时同时改首尾，保留中间未改划线句
    const longBefore = `甲。${"长".repeat(1600)}风停了。${"短".repeat(1600)}乙。`;
    const longAfter = `丙。${"长".repeat(1600)}风停了。${"短".repeat(1600)}丁。`;
    const windStart = longBefore.indexOf("风停了。");
    const longMigrated = reconcileQuotesOnRevisedTextChange(longBefore, longAfter, [{
      advice: "补风停",
      revisedQuotes: ["风停了。"],
      revisedRanges: [{ start: windStart, end: windStart + 4, actionIndex: 0, text: "风停了。" }],
    }]);
    expect(longMigrated[0]?.revisedRanges).toEqual([{ start: windStart, end: windStart + 4, actionIndex: 0, text: "风停了。" }]);

    // M6: 50,001 字划最后一字与 20,000 字标线中间插一字均合法保存且不丢标线
    const text50k = `${"字".repeat(50_000)}尾`;
    const range50k = [{ start: 50_000, end: 50_001, actionIndex: 0 }];
    expect(validateQuoteRangesCapacity(text50k, range50k, 1, "末字")).toBeNull();
    expect(paragraphReviewSchema.safeParse({
      paragraphId: "paragraph-1",
      suggestions: [{
        advice: "末字",
        revisedQuotes: rangesToRevisedQuotes(text50k, range50k, 1),
        revisedRanges: rangesToPersistedRanges(text50k, range50k, 1),
      }],
      revisedText: text50k,
    }).success).toBe(true);

    const text20k = "文".repeat(20_000);
    const text20kPlus1 = `${"文".repeat(10_000)}插${"文".repeat(10_000)}`;
    const migrated20k = reconcileQuotesOnRevisedTextChange(text20k, text20kPlus1, [{
      advice: "整段",
      revisedQuotes: rangesToRevisedQuotes(text20k, [{ start: 0, end: 20_000, actionIndex: 0 }], 1),
      revisedRanges: [{ start: 0, end: 20_000, actionIndex: 0, text: text20k }],
    }]);
    expect(migrated20k[0]?.revisedRanges).toEqual([{ start: 0, end: 20_001, actionIndex: 0, text: text20kPlus1 }]);

    // m2: 1..100 连续编号完整拆出 100 条
    const hundred = Array.from({ length: 100 }, (_, i) => `${i + 1}. 动作${i + 1}`).join("\n");
    expect(splitParagraphActions(hundred)).toHaveLength(100);
    expect(splitParagraphActionSlices(hundred)).toHaveLength(100);
    expect(splitParagraphActionSlices(hundred)[99]?.body).toBe("动作100");

    // Round 3 Major 1: 全选 editHint=[0,len] 并粘贴首尾替换文本，中间未改划线句照常保留
    const fullSelectBefore = "甲。风停了。乙。";
    const fullSelectAfter = "丙。风停了。丁。";
    const fullSelectMigrated = reconcileQuotesOnRevisedTextChange(
      fullSelectBefore,
      fullSelectAfter,
      [{ advice: "补风停", revisedQuotes: ["风停了。"], revisedRanges: [{ start: 2, end: 6, actionIndex: 0, text: "风停了。" }] }],
      { start: 0, end: fullSelectBefore.length },
    );
    expect(fullSelectMigrated[0]?.revisedRanges).toEqual([{ start: 2, end: 6, actionIndex: 0, text: "风停了。" }]);

    // Round 3 Major 4: 无标点超长段（两侧合计 > 28,000 码点）首尾替换，中间未改划线词保留
    const unpunctBefore = `甲${"长".repeat(7000)}风停了${"短".repeat(7000)}乙。`;
    const unpunctAfter = `丙${"长".repeat(7000)}风停了${"短".repeat(7000)}丁。`;
    const unpunctPos = unpunctBefore.indexOf("风停了");
    const unpunctMigrated = reconcileQuotesOnRevisedTextChange(unpunctBefore, unpunctAfter, [{
      advice: "补风停",
      revisedQuotes: ["风停了"],
      revisedRanges: [{ start: unpunctPos, end: unpunctPos + 3, actionIndex: 0, text: "风停了" }],
    }]);
    expect(unpunctMigrated[0]?.revisedRanges).toEqual([{ start: unpunctPos, end: unpunctPos + 3, actionIndex: 0, text: "风停了" }]);

    // Round 3 Minor 1: 超长 200,000+ 偏移段首插字后仍保持精确 revisedRanges（上限提升至 10,000,000）
    const atCapBefore = `乙${"文".repeat(199_998)}乙`;
    const atCapAfter = `首${atCapBefore}`;
    const atCapMigrated = reconcileQuotesOnRevisedTextChange(atCapBefore, atCapAfter, [{
      advice: "末字",
      revisedQuotes: ["乙"],
      revisedRanges: [{ start: 199_999, end: 200_000, actionIndex: 0, text: "乙" }],
    }]);
    expect(atCapMigrated[0]?.revisedRanges).toEqual([{ start: 200_000, end: 200_001, actionIndex: 0, text: "乙" }]);
    expect(buildAdviceRevisionRuns("", atCapAfter, atCapMigrated)).toEqual([
      { kind: "unchanged", text: `首乙${"文".repeat(199_998)}` },
      { kind: "inserted", text: "乙", underline: "single", actionIndex: 0 },
    ]);

    // Round 4 Major-1: 非单字重复的真实无标点长段（千字文周期语料）首尾替换及仅改首字全选粘贴，滑动窗口 CDC 稳定保留中间标线
    const proseA = `甲${"天地玄黄宇宙洪荒日月盈昃辰宿列张".repeat(150)}风停了${"寒来暑往秋收冬藏闰余成岁律吕调阳".repeat(150)}乙`;
    const proseB = `丙丁戊${"天地玄黄宇宙洪荒日月盈昃辰宿列张".repeat(150)}风停了${"寒来暑往秋收冬藏闰余成岁律吕调阳".repeat(150)}己`;
    const prosePosA = proseA.indexOf("风停了");
    const prosePosB = proseB.indexOf("风停了");
    const proseMigrated = reconcileQuotesOnRevisedTextChange(
      proseA,
      proseB,
      [{ advice: "补风停", revisedQuotes: ["风停了"], revisedRanges: [{ start: prosePosA, end: prosePosA + 3, actionIndex: 0, text: "风停了" }] }],
      { start: 0, end: proseA.length },
    );
    expect(proseMigrated[0]?.revisedRanges).toEqual([{ start: prosePosB, end: prosePosB + 3, actionIndex: 0, text: "风停了" }]);

    // Round 4 Major-2: 40,000+ 字无标点及密集标点全异文本替换均 < 150ms
    const disjointA = "甲乙丙丁戊己庚".repeat(6000);
    const disjointB = "子丑寅卯辰巳午".repeat(6000);
    const t0 = performance.now();
    const disjointResult = reconcileQuotesOnRevisedTextChange(disjointA, disjointB, [{
      advice: "重写",
      revisedQuotes: ["甲乙丙"],
      revisedRanges: [{ start: 0, end: 3, actionIndex: 0, text: "甲乙丙" }],
    }]);
    expect(performance.now() - t0).toBeLessThan(150);
    expect(disjointResult[0]?.revisedRanges).toEqual([]);

    const punctDisjointA = "甲，".repeat(20_000);
    const punctDisjointB = "乙，".repeat(20_000);
    const t1 = performance.now();
    const punctDisjointResult = reconcileQuotesOnRevisedTextChange(punctDisjointA, punctDisjointB, [{
      advice: "重写",
      revisedQuotes: ["甲，"],
      revisedRanges: [{ start: 0, end: 2, actionIndex: 0, text: "甲，" }],
    }]);
    expect(performance.now() - t1).toBeLessThan(150);
    expect(punctDisjointResult[0]?.revisedRanges).toEqual([]);

    // Round 4 Minor-1: 原本已全部失效的历史 revisedQuotes 微调动作或正文时丢弃脏摘录，保留自动单下划线回退
    const brokenLegacyAdvice = reconcileQuotesOnAdviceChange(
      "春雨落在窗台。",
      [{ advice: "旧动作", revisedQuotes: ["完全不存在的旧句子"] }],
      "新动作",
    );
    expect(brokenLegacyAdvice).toEqual({ advice: "新动作" });
    const brokenLegacyText = reconcileQuotesOnRevisedTextChange(
      "春雨落在窗台。",
      "春雨轻轻落在窗台。",
      [{ advice: "补细节", revisedQuotes: ["完全不存在的旧句子"] }],
    );
    expect(brokenLegacyText).toEqual([{ advice: "补细节" }]);

    // Round 5 Major-1: <= 4,000 字常规中等篇幅段落首尾累计改写超过 512 字（如首尾各改 320+ 字或首改 560 字+句末换标点）全选粘贴时，中间未改句标线完整保留
    const midKeep = "风停了，檐角的雨珠一滴一滴落在青石板上。";
    const mediumBefore = `${"春风拂过湖面，柳枝轻摇。".repeat(30)}${midKeep}${"远处山影朦胧，暮色四合。".repeat(30)}。`;
    const mediumAfter = `${"秋雨敲打窗棂，灯火微明。".repeat(35)}${midKeep}${"院中落叶满阶，夜凉如水。".repeat(30)}！`;
    expect(mediumBefore.length + mediumAfter.length).toBeLessThanOrEqual(4_000);
    const midPosBefore = mediumBefore.indexOf(midKeep);
    const midPosAfter = mediumAfter.indexOf(midKeep);
    const mediumMigrated = reconcileQuotesOnRevisedTextChange(
      mediumBefore,
      mediumAfter,
      [{
        advice: "保留中间细节句",
        revisedQuotes: [midKeep],
        revisedRanges: [{ start: midPosBefore, end: midPosBefore + midKeep.length, actionIndex: 0, text: midKeep }],
      }],
      { start: 0, end: mediumBefore.length },
    );
    expect(mediumMigrated[0]?.revisedRanges).toEqual([
      { start: midPosAfter, end: midPosAfter + midKeep.length, actionIndex: 0, text: midKeep },
    ]);

    // Round 3 Minor 2: 本段无需修改即使不带 revisedQuotes 也不回退整段单下划线
    expect(buildAdviceRevisionRuns("我站着。", "雨点落在窗沿，泥土泛出清香。", [{ advice: "本段无需修改" }])).toEqual([
      { kind: "unchanged", text: "雨点落在窗沿，泥土泛出清香。" },
    ]);
  });
});
