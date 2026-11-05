// @vitest-environment node

import { describe, expect, it } from "vitest";

import { cleanJsonResponse, parseJsonResponse, tryParseJsonResponse } from "./json-response";

/**
 * 线上「这件事打动了我」以 AI_INVALID_RESPONSE_json_parse 失败。失败任务只保存
 * 错误码，不保存模型原文，因此这些夹具按该作业的实际提示词形态重建：逐段建议
 * 要求用「1. 」「2. 」分行，正文要引用学生原句，结构要求里又带着中文引号的举例。
 */
const brokenAdviceNewline = `{"report":{"version":2,"themeFit":"fits","grade":"B","paragraphReviews":[{"paragraphId":"paragraph-1","suggestions":[{"advice":"1. 补上名人名言引入
2. 埋下“抑”的伏笔"}],"revisedText":"生活中有许多小感动。"}]},"annotationAnchors":[]}`;

const brokenAdviceQuotes =
  '{"report":{"grade":"B","paragraphReviews":[{"advice":"把"脏兮兮的手"换成原文自己的细节","revisedText":"正文"}]}}';

describe("cleanJsonResponse", () => {
  it("剥离 Markdown 围栏和对象前后的多余文字", () => {
    expect(cleanJsonResponse('好的，以下是批改结果：\n```json\n{"grade":"B"}\n```\n希望对你有帮助。'))
      .toBe('{"grade":"B"}');
  });

  it("围栏没有闭合时也能取出对象", () => {
    expect(cleanJsonResponse('```json\n{"grade":"B"}')).toBe('{"grade":"B"}');
  });

  it("只取第一个括号配平的对象，不被字符串里的括号干扰", () => {
    expect(cleanJsonResponse('{"advice":"用 {} 表示空集"}\n{"note":"多余对象"}'))
      .toBe('{"advice":"用 {} 表示空集"}');
  });
});

describe("tryParseJsonResponse", () => {
  it("合法 JSON 原样解析", () => {
    expect(tryParseJsonResponse('{"grade":"B","painPoints":["补细节"]}'))
      .toEqual({ ok: true, value: { grade: "B", painPoints: ["补细节"] } });
  });

  it("修复逐段建议里的裸换行", () => {
    const attempt = tryParseJsonResponse(brokenAdviceNewline);

    expect(attempt.ok).toBe(true);
    if (!attempt.ok) return;
    const value = attempt.value as { report: { paragraphReviews: Array<{ suggestions: Array<{ advice: string }> }> } };
    expect(value.report.paragraphReviews[0]!.suggestions[0]!.advice)
      .toBe("1. 补上名人名言引入\n2. 埋下“抑”的伏笔");
  });

  it("修复字符串内未转义的双引号", () => {
    const attempt = tryParseJsonResponse(brokenAdviceQuotes);

    expect(attempt.ok).toBe(true);
    if (!attempt.ok) return;
    const value = attempt.value as { report: { paragraphReviews: Array<{ advice: string }> } };
    expect(value.report.paragraphReviews[0]!.advice).toBe('把"脏兮兮的手"换成原文自己的细节');
  });

  it("未转义引号后跟中文逗号时不提前结束字符串", () => {
    expect(tryParseJsonResponse('{"advice":"他说"老师万岁"，我也喊了一声","revisedText":"正文"}'))
      .toEqual({ ok: true, value: { advice: '他说"老师万岁"，我也喊了一声', revisedText: "正文" } });
  });

  it("把中文引号当作 JSON 引号时仍能解析", () => {
    expect(tryParseJsonResponse("{“advice”：“补上伏笔”，“revisedText”：“正文”}"))
      .toEqual({ ok: true, value: { advice: "补上伏笔", revisedText: "正文" } });
  });

  it("中文引号包裹的字符串里，不收尾的中文右引号保持原样", () => {
    expect(tryParseJsonResponse("{“advice”：“写出”抑“的伏笔”，“revisedText”：“正文”}"))
      .toEqual({ ok: true, value: { advice: "写出”抑“的伏笔", revisedText: "正文" } });
  });

  it("带 BOM 的合法 JSON 原样解析", () => {
    expect(tryParseJsonResponse('\uFEFF{"a":"x, y"}')).toEqual({ ok: true, value: { a: "x, y" } });
  });

  it("合法 JSON 中的中文标点、引号和注释样文字不被改动", () => {
    const value = { advice: "他说：“好，”然后笑了。// 不是注释", list: ["a,", "}"] };
    expect(tryParseJsonResponse(JSON.stringify(value))).toEqual({ ok: true, value });
  });

  it.each([
    ['{"a":1,"b":[1,2,],}', { a: 1, b: [1, 2] }],
    ['{\n  // 第一段\n  "a":1,\n  /* 第二段 */ "b":2\n}', { a: 1, b: 2 }],
    ['{"a":"前\t后"}', { a: "前\t后" }],
    ['{"a":"C:\\path"}', { a: "C:\\path" }],
  ])("修复结尾逗号、注释、制表符与非法转义：%s", (content, expected) => {
    expect(tryParseJsonResponse(content)).toEqual({ ok: true, value: expected });
  });

  it("完全没有 JSON 对象时返回解析错误而不抛出", () => {
    const attempt = tryParseJsonResponse("模型拒绝回答。");

    expect(attempt.ok).toBe(false);
    if (attempt.ok) return;
    expect(attempt.error).toBeInstanceOf(SyntaxError);
  });

  it("截断的输出不猜测缺失内容", () => {
    expect(tryParseJsonResponse('{"report":{"grade":"B","revisedText":"写到一半').ok).toBe(false);
  });
});

describe("parseJsonResponse", () => {
  it("解析失败时抛出 SyntaxError，使失败分类仍为 json_parse", () => {
    expect(() => parseJsonResponse("not-json")).toThrow(SyntaxError);
  });
});
