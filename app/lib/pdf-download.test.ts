import { afterEach, describe, expect, it, vi } from "vitest";

import { triggerFileDownload } from "./pdf-download";

describe("PDF 文件下载", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
    delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
  });

  it("直接下载生成的 PDF 文件，不创建打印窗口", () => {
    const createObjectURL = vi.fn(() => "blob:review-pdf");
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const open = vi.spyOn(window, "open");

    triggerFileDownload(new Blob(["pdf"], { type: "application/pdf" }), "为自己鼓掌-张小明.pdf");

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:review-pdf");
  });
});
