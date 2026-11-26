import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { DeliveryDocument } from "@/src/delivery/contracts";
import { PrintReview } from "./PrintReview";

const document: DeliveryDocument = {
  title: "为自己鼓掌",
  studentName: "张小明",
  paragraphs: [{
    paragraphNumber: 1,
    crops: [{ pageIndex: 0, bytes: new Uint8Array([1]), width: 1200, height: 260 }],
    suggestions: [{ problem: "动作略快", advice: "补充听觉", example: "我听见呼吸声。" }],
    revisionRuns: [
      { kind: "unchanged", text: "我" },
      { kind: "deleted", text: "慢慢" },
      { kind: "inserted", text: "终于" },
      { kind: "punctuation", text: "，" },
      { kind: "unchanged", text: "走上台。" },
    ],
  }],
};

describe("A4 打印稿", () => {
  it("按共享分页顺序输出裁图、建议和修改稿并隐藏删除内容", () => {
    const { container } = render(
      <PrintReview document={document} cropSources={[["blob:paragraph-1"]]} />,
    );

    expect(container.firstElementChild).toHaveAttribute("data-print-ready", "true");
    const sheet = container.querySelector('[data-print-section="page-1"]');
    expect(sheet).not.toBeNull();
    expect(within(sheet as HTMLElement).getByRole("heading", { name: "为自己鼓掌" })).toBeVisible();
    expect(within(sheet as HTMLElement).getByRole("img", { name: "第 1 段原文裁图，第 1 页" }))
      .toHaveAttribute("src", "blob:paragraph-1");
    expect(sheet).toHaveTextContent("【修改动作】");
    expect(sheet).toHaveTextContent("补充听觉");
    expect(sheet).not.toHaveTextContent("动作略快");
    expect(sheet).not.toHaveTextContent("我听见呼吸声");
    expect(sheet).toHaveTextContent("【改后全段】");
    expect(container.querySelector('[data-run-kind="deleted"]')).toBeNull();
    expect(sheet).not.toHaveTextContent("慢慢");
    expect(container.querySelector('[data-run-kind="inserted"]')).toHaveTextContent("终于");
    expect(container.querySelector('[data-page-kind="feedback"]')).toBeNull();
  });

  it("超长修改稿使用分页器生成段落和修改稿续标题", () => {
    const longDocument: DeliveryDocument = {
      ...document,
      paragraphs: [{
        ...document.paragraphs[0],
        revisionRuns: [{ kind: "inserted", text: "我终于勇敢地走上舞台。".repeat(900) }],
      }],
    };
    const { container } = render(
      <PrintReview document={longDocument} cropSources={[["blob:paragraph-1"]]} />,
    );

    expect(container.querySelectorAll("[data-print-section]").length).toBeGreaterThan(1);
    expect(screen.getAllByText("【第 1 段（续）】").length).toBeGreaterThan(0);
    expect(screen.getAllByText("【改后全段（续）】").length).toBeGreaterThan(0);
  });

  it("打印稿同步渲染手改后的修改动作线型与改后全段线型", () => {
    const manualDoc: DeliveryDocument = {
      title: "温暖的一句话",
      studentName: "张小明",
      paragraphs: [{
        paragraphNumber: 1,
        crops: [{ pageIndex: 0, bytes: new Uint8Array([1]), width: 1200, height: 260 }],
        suggestions: [{
          advice: "1、解释名言\n2、换用贴切名言\n3、点出转折心理",
          revisedQuotes: ["一句温暖的话。", "“良言一句三冬暖。”", "我以前却不这么想。"],
        }],
        actionUnderlines: ["single", "wave", "dotDotDash"],
        revisionRuns: [
          { kind: "inserted", text: "“良言一句三冬暖。”", underline: "wave", actionIndex: 1 },
          { kind: "inserted", text: "一句温暖的话。", underline: "single", actionIndex: 0 },
          { kind: "inserted", text: "我以前却不这么想。", underline: "dotDotDash", actionIndex: 2 },
          { kind: "unchanged", text: "那时我最怕金老师。" },
        ],
      }],
    };
    const { container } = render(
      <PrintReview document={manualDoc} cropSources={[["blob:paragraph-1"]]} />,
    );
    const actionSpans = [...container.querySelectorAll<HTMLElement>("[data-action-underline]")];
    expect(actionSpans.map((el) => [el.textContent, el.getAttribute("data-action-underline")])).toEqual([
      ["解释名言", "single"],
      ["换用贴切名言", "wave"],
      ["点出转折心理", "dotDotDash"],
    ]);
    expect(actionSpans[2]?.style.backgroundImage).toContain("data:image/svg+xml");
    const revisedSpans = [...container.querySelectorAll<HTMLElement>("[data-underline]")];
    expect(revisedSpans.map((el) => [el.textContent, el.getAttribute("data-underline")])).toEqual([
      ["“良言一句三冬暖。”", "wave"],
      ["一句温暖的话。", "single"],
      ["我以前却不这么想。", "dotDotDash"],
    ]);
    expect(revisedSpans[2]?.style.backgroundImage).toContain("data:image/svg+xml");
  });
});
