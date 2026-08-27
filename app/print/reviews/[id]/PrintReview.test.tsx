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
  it("按共享分页顺序输出裁图、建议和红黑修订", () => {
    const { container } = render(
      <PrintReview document={document} cropSources={[["blob:paragraph-1"]]} />,
    );

    expect(container.firstElementChild).toHaveAttribute("data-print-ready", "true");
    const sheet = container.querySelector('[data-print-section="page-1"]');
    expect(sheet).not.toBeNull();
    expect(within(sheet as HTMLElement).getByRole("heading", { name: "为自己鼓掌" })).toBeVisible();
    expect(within(sheet as HTMLElement).getByRole("img", { name: "第 1 段原文裁图，第 1 页" }))
      .toHaveAttribute("src", "blob:paragraph-1");
    expect(sheet).toHaveTextContent("【修改建议】");
    expect(sheet).toHaveTextContent("动作略快");
    expect(sheet).toHaveTextContent("【修改后段落】");
    expect(container.querySelector('[data-run-kind="deleted"]')).toHaveTextContent("慢慢");
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
    expect(screen.getAllByText("【修改后段落（续）】").length).toBeGreaterThan(0);
  });
});
