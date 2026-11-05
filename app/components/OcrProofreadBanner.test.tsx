import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { OcrProofreadBanner } from "./OcrProofreadBanner";

const ocr = (text: string, warnings: string[] = [], readable = true) => ({
  version: 2 as const,
  ocrRevision: 1,
  editedAt: null,
  pages: [{ pageIndex: 0, text, readable, warnings }],
  paragraphs: [{ id: "paragraph-1", paragraphIndex: 0, text, segments: [{ pageIndex: 0, x: 0.1, y: 0.1, width: 0.5, height: 0.1 }] }],
});

describe("识别原文校对提示", () => {
  it("识别正常时不显示", () => {
    const { container } = render(<OcrProofreadBanner ocr={ocr("我为自己鼓掌。")} />);
    expect(container).toBeEmptyDOMElement();
    expect(render(<OcrProofreadBanner ocr={null} />).container).toBeEmptyDOMElement();
  });

  it("模型警告时显著提示并给出原因，可跳转到识别原文", async () => {
    const open = vi.fn();
    render(<OcrProofreadBanner ocr={ocr("我为自己鼓掌。", ["第二行字迹模糊"])} onOpenOcr={open} />);
    const alert = screen.getByRole("alert", { name: "请先校对识别原文" });
    expect(alert).toHaveTextContent("请先校对识别原文");
    expect(alert).toHaveTextContent("模型警告：第二行字迹模糊");
    await userEvent.setup().click(screen.getByRole("button", { name: "去校对识别原文" }));
    expect(open).toHaveBeenCalledOnce();
  });

  it("占位符比例偏高时提示并显示比例", () => {
    render(<OcrProofreadBanner ocr={ocr("我□□天去□□")} />);
    expect(screen.getByRole("alert")).toHaveTextContent("看不清的字（「□」）共 4 个，占正文 57.1%");
  });
});
