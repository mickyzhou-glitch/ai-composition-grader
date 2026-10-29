// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../globals.css", import.meta.url), "utf8");

describe("段落原文预览样式", () => {
  it("桌面和移动端都不把段落图限制在固定比例或隐藏溢出的框中", () => {
    const figures = [...css.matchAll(/\.paragraph-crop\s*\{([^}]+)\}/gu)];
    expect(figures.length).toBeGreaterThan(0);
    for (const [, rules] of figures) {
      expect(rules).not.toMatch(/aspect-ratio\s*:|(?:^|;)\s*(?:height|max-height)\s*:|overflow(?:-y)?\s*:\s*(?:hidden|clip)/u);
    }
  });

  it("图片按原始比例随宽度缩放，高段落也能完整展开", () => {
    const images = [...css.matchAll(/\.paragraph-crop img\s*\{([^}]+)\}/gu)];
    expect(images.length).toBeGreaterThan(0);
    for (const [, rules] of images) {
      expect(rules).toMatch(/(?:^|;)\s*height:\s*auto\s*;/u);
      expect(rules).not.toMatch(/max-height\s*:|object-fit\s*:\s*cover/u);
    }
  });
});
