// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { PdfBatchService } from "./pdf-batch-service";

describe("PdfBatchService", () => {
  it("按所选顺序生成包含每篇 PDF 的 ZIP", async () => {
    const getOrCreate = vi
      .fn()
      .mockResolvedValueOnce({
        filename: "作文批改-为自己鼓掌-张小明.pdf",
        data: Buffer.from("first-pdf"),
      })
      .mockResolvedValueOnce({
        filename: "作文批改-珍贵的礼物-李羿辰.pdf",
        data: Buffer.from("second-pdf"),
      });
    const service = new PdfBatchService({ getOrCreate } as never);

    const result = await service.exportBatch("teacher-1", ["review-1", "review-2"]);

    expect(result.filename).toBe("作文批改批量导出.zip");
    expect(result.data.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    expect(result.data.includes(Buffer.from("first-pdf"))).toBe(true);
    expect(result.data.includes(Buffer.from("second-pdf"))).toBe(true);
    expect(result.data.includes(Buffer.from("作文批改-为自己鼓掌-张小明.pdf"))).toBe(true);
    expect(getOrCreate).toHaveBeenCalledWith("teacher-1", "review-1");
    expect(getOrCreate).toHaveBeenCalledWith("teacher-1", "review-2");
  });
});
