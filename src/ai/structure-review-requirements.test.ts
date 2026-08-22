// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  buildStructureReviewRule,
  parseNumberedStructureRequirements,
  validateStructureRequirementCoverage,
} from "./structure-review-requirements";

const numberedRequirements = "1. 开头倒叙。 2. 交代困难。 3. 详写努力。";

describe("parseNumberedStructureRequirements", () => {
  it("拆分同一行的连续编号要求", () => {
    expect(parseNumberedStructureRequirements(
      "1. 开头倒叙。 2、交代困难。 3）详写努力。 4．写出结果。 5) 回扣标题。",
    )).toEqual([
      "开头倒叙。",
      "交代困难。",
      "详写努力。",
      "写出结果。",
      "回扣标题。",
    ]);
  });

  it("拆分多行连续编号要求", () => {
    expect(parseNumberedStructureRequirements("1. 开头\n2. 经过\n3. 结果"))
      .toEqual(["开头", "经过", "结果"]);
  });

  it.each([
    "开头点题，结尾升华。",
    "1. 开头点题。",
    "1. 开头点题。 3. 结尾升华。",
    "2. 先写经过。 3. 再写结果。",
    "1.  2. 写出结果。",
  ])("无法可靠拆分时返回 null: %s", (value) => {
    expect(parseNumberedStructureRequirements(value)).toBeNull();
  });
});

describe("structure review coverage", () => {
  it("为编号要求生成逐项输出规则", () => {
    const rule = buildStructureReviewRule(numberedRequirements);

    expect(rule).toContain("【第1项】");
    expect(rule).toContain("【第3项】");
    expect(rule).toContain("部分符合");
    expect(rule).toContain("原文依据");
    expect(rule).toContain("详写努力");
  });

  it("为普通自然语言生成单项结构核对规则", () => {
    const rule = buildStructureReviewRule("开头点题，结尾升华。");

    expect(rule).toContain("逐段核对");
    expect(rule).toContain("开头点题，结尾升华");
    expect(rule).not.toContain("【第1项】");
  });

  it("接受按顺序完整回答的结构诊断", () => {
    expect(() => validateStructureRequirementCoverage([
      "【第1项】符合：首段先写比赛结果。",
      "【第2项】部分符合：第二段提到困难但不具体。",
      "【第3项】不符合：原文没有详写努力过程。",
    ].join("\n"), numberedRequirements)).not.toThrow();
  });

  it.each([
    "【第1项】符合：有依据。\n【第3项】不符合：有依据。",
    "【第1项】符合：有依据。\n【第1项】符合：有依据。\n【第3项】不符合：有依据。",
    "【第2项】符合：有依据。\n【第1项】符合：有依据。\n【第3项】不符合：有依据。",
    "【第1项】判断：有依据。\n【第2项】符合：有依据。\n【第3项】符合：有依据。",
    "【第1项】符合：有依据。\n【第2项】符合：有依据。\n【第3项】符合：",
  ])("拒绝不完整或无稳定状态的逐项诊断", (finding) => {
    expect(() => validateStructureRequirementCoverage(finding, numberedRequirements))
      .toThrow(/structure coverage invalid/u);
  });

  it("普通自然语言要求不启用逐项校验", () => {
    expect(() => validateStructureRequirementCoverage(
      "结构基本完整。",
      "开头点题，结尾升华。",
    )).not.toThrow();
  });
});
