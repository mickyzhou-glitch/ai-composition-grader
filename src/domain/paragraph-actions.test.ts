import { describe, expect, it } from "vitest";

import {
  collapseParagraphSuggestions,
  mergedParagraphAction,
  UNCHANGED_PARAGRAPH_ACTION,
} from "./paragraph-actions";

describe("paragraph actions", () => {
  it("一条建议原样保留，多条按段编号合并", () => {
    expect(mergedParagraphAction([{ advice: "补听觉" }])).toBe("补听觉");
    expect(mergedParagraphAction([
      { advice: "补听觉" },
      { advice: " 补动作 " },
      { advice: "收束主题" },
    ])).toBe("1. 补听觉\n2. 补动作\n3. 收束主题");
    expect(mergedParagraphAction([])).toBe(UNCHANGED_PARAGRAPH_ACTION);
  });

  it("折叠后仍是一条建议，单条对象保持不变", () => {
    const single = [{ advice: "补听觉", problem: "略快" }];
    expect(collapseParagraphSuggestions(single)).toEqual(single);
    expect(collapseParagraphSuggestions([
      { advice: "补听觉", problem: "略快" },
      { advice: "补动作" },
    ])).toEqual([{ advice: "1. 补听觉\n2. 补动作", problem: "略快" }]);
  });
});