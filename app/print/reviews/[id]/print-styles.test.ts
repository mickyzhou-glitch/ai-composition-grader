// @vitest-environment node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  fileURLToPath(new URL("./print.module.css", import.meta.url)),
  "utf8",
);

describe("PDF 打印样式", () => {
  it("使用 A4 横向三栏并完整显示原图", () => {
    expect(css).toMatch(/@page\s*{[^}]*size:\s*A4 landscape;/s);
    expect(css).toMatch(/\.feedbackLayout\s*{[^}]*(?<!min-)height:\s*210mm;[^}]*grid-template-columns:\s*19\.5% 44% 36\.5%;/s);
    expect(css).toMatch(/\.imageFigure img\s*{[^}]*object-fit:\s*contain;/s);
  });

  it("范文使用红色楷体，其他文字使用蓝色黑体", () => {
    expect(css).toMatch(/\.document\s*{[^}]*color:\s*var\(--blue\);[^}]*font-family:\s*var\(--heiti\);/s);
    expect(css).toMatch(/\.modelColumn\s*{[^}]*color:\s*var\(--red\);[^}]*font-family:\s*var\(--kaiti\);[^}]*font-size:\s*9\.5pt;[^}]*line-height:\s*1\.3;/s);
  });
});
