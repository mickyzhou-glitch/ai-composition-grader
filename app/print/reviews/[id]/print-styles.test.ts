// @vitest-environment node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  fileURLToPath(new URL("./print.module.css", import.meta.url)),
  "utf8",
);

describe("PDF 打印样式", () => {
  it("使用 A4 纵向和统一页边距，不保留横向三栏", () => {
    expect(css).toMatch(/@page\s*{[^}]*size:\s*A4 portrait;[^}]*margin:\s*16mm 18mm;/);
    expect(css).not.toMatch(/landscape|grid-template-columns:\s*19\.5% 44% 36\.5%/u);
    expect(css).toMatch(/\.sheet\s*{[^}]*width:\s*174mm;/);
  });

  it("使用浅橙建议、楷体修改稿与蓝色划线标注", () => {
    expect(css).toMatch(/\.suggestions\s*{[^}]*background:\s*#fff0bd;/);
    expect(css).toMatch(/\.revision\s*{[^}]*font-family:\s*"LXGW WenKai", STKaiti, KaiTi, serif;[^}]*font-size:\s*11\.5pt;[^}]*color:\s*#171717;/);
    expect(css).toMatch(/\.inserted\s*{[^}]*color:\s*#1f4e78;[^}]*text-decoration:\s*underline;/);
    expect(css).not.toMatch(/\.deleted\s*{|text-decoration:\s*line-through;/);
    expect(css).not.toMatch(/--blue|#255ab1/u);
  });
});
