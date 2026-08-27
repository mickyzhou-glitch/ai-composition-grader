import { describe, expect, it } from "vitest";

import { buildRevisionRuns } from "./revision-diff";

describe("buildRevisionRuns", () => {
  it("将删除和新增文字标红，修改稿标点保持黑色", () => {
    expect(buildRevisionRuns("我很高兴。", "我非常高兴！")).toEqual([
      { kind: "unchanged", text: "我" },
      { kind: "deleted", text: "很" },
      { kind: "inserted", text: "非常" },
      { kind: "unchanged", text: "高兴" },
      { kind: "punctuation", text: "！" },
    ]);
  });

  it("标点替换不会产生删除标点", () => {
    expect(buildRevisionRuns("你好，世界。", "你好。世界！")).toEqual([
      { kind: "unchanged", text: "你好" },
      { kind: "punctuation", text: "。" },
      { kind: "unchanged", text: "世界" },
      { kind: "punctuation", text: "！" },
    ]);
  });

  it("将两侧都唯一的连续文字调序视为移动", () => {
    expect(buildRevisionRuns("我先整理书桌，再浇花。", "我先浇花，再整理书桌。")).toEqual([
      { kind: "unchanged", text: "我先浇花" },
      { kind: "punctuation", text: "，" },
      { kind: "unchanged", text: "再整理书桌" },
      { kind: "punctuation", text: "。" },
    ]);
  });

  it("支持纯新增", () => {
    expect(buildRevisionRuns("", "你好！")).toEqual([
      { kind: "inserted", text: "你好" },
      { kind: "punctuation", text: "！" },
    ]);
  });

  it("支持纯删除且不输出原稿标点", () => {
    expect(buildRevisionRuns("你好！", "")).toEqual([
      { kind: "deleted", text: "你好" },
    ]);
  });

  it("识别整句唯一调序", () => {
    expect(buildRevisionRuns("春天来了夏天到了。", "夏天到了春天来了。")).toEqual([
      { kind: "unchanged", text: "夏天到了春天来了" },
      { kind: "punctuation", text: "。" },
    ]);
  });

  it("重复汉字使移动候选不唯一时不猜测", () => {
    expect(buildRevisionRuns("甲乙甲丙", "乙甲丙甲")).toEqual([
      { kind: "deleted", text: "甲" },
      { kind: "unchanged", text: "乙甲丙" },
      { kind: "inserted", text: "甲" },
    ]);
  });

  it("连续多处修改始终先输出删除再输出新增", () => {
    expect(buildRevisionRuns("今天天气好，我们去公园。", "明天天气好，我们回校园。")).toEqual([
      { kind: "deleted", text: "今" },
      { kind: "inserted", text: "明" },
      { kind: "unchanged", text: "天天气好" },
      { kind: "punctuation", text: "，" },
      { kind: "unchanged", text: "我们" },
      { kind: "deleted", text: "去公" },
      { kind: "inserted", text: "回校" },
      { kind: "unchanged", text: "园" },
      { kind: "punctuation", text: "。" },
    ]);
  });

  it.each([
    { separator: "，", label: "逗号" },
    { separator: " ", label: "空格" },
  ])("将$label中性边界放在同一锚点的删除和新增之前", ({ separator }) => {
    expect(buildRevisionRuns(`甲${separator}乙`, `甲${separator}丙`)).toEqual([
      { kind: "unchanged", text: "甲" },
      { kind: "punctuation", text: separator },
      { kind: "deleted", text: "乙" },
      { kind: "inserted", text: "丙" },
    ]);
  });

  it.each([
    { separator: "\n", label: "LF" },
    { separator: "\r\n", label: "CRLF" },
  ])("将 $label 换行边界放在同一锚点的删除和新增之前", ({ separator }) => {
    expect(buildRevisionRuns(
      `第一行${separator}旧第二行`,
      `第一行${separator}新第二行`,
    )).toEqual([
      { kind: "unchanged", text: "第一行" },
      { kind: "punctuation", text: separator },
      { kind: "deleted", text: "旧" },
      { kind: "inserted", text: "新" },
      { kind: "unchanged", text: "第二行" },
    ]);
  });

  it("纯尾部删除仍在修改稿尾标点之前", () => {
    expect(buildRevisionRuns("你好旧！", "你好！")).toEqual([
      { kind: "unchanged", text: "你好" },
      { kind: "deleted", text: "旧" },
      { kind: "punctuation", text: "！" },
    ]);
  });

  it("只保留修改稿的 CRLF 和换行并以黑色输出", () => {
    expect(buildRevisionRuns("第一行\r\n第二行", "第一行\n新第二行")).toEqual([
      { kind: "unchanged", text: "第一行" },
      { kind: "punctuation", text: "\n" },
      { kind: "inserted", text: "新" },
      { kind: "unchanged", text: "第二行" },
    ]);
  });

  it("不拆分 emoji 字素", () => {
    expect(buildRevisionRuns("我喜欢👨‍👩‍👧。", "我喜欢👩‍👩‍👧。")).toEqual([
      { kind: "unchanged", text: "我喜欢" },
      { kind: "deleted", text: "👨‍👩‍👧" },
      { kind: "inserted", text: "👩‍👩‍👧" },
      { kind: "punctuation", text: "。" },
    ]);
  });

  it("不拆分 Unicode 代理对", () => {
    expect(buildRevisionRuns("𠮷好", "𠮸好")).toEqual([
      { kind: "deleted", text: "𠮷" },
      { kind: "inserted", text: "𠮸" },
      { kind: "unchanged", text: "好" },
    ]);
  });

  it("不拆分组合字符", () => {
    expect(buildRevisionRuns("Cafe\u0301", "Café")).toEqual([
      { kind: "unchanged", text: "Caf" },
      { kind: "deleted", text: "e\u0301" },
      { kind: "inserted", text: "é" },
    ]);
  });

  it.each(["‼️", "⁉️", "，️"])("将带变体选择符的标点 %s 视为中性", (sourcePunctuation) => {
    expect(buildRevisionRuns(`你好${sourcePunctuation}`, "你好！")).toEqual([
      { kind: "unchanged", text: "你好" },
      { kind: "punctuation", text: "！" },
    ]);
  });
});
