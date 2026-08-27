import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const cropImageRegion = vi.hoisted(() => vi.fn(async () => ({
  bytes: new Uint8Array([1, 2, 3]),
  width: 520,
  height: 480,
})));

vi.mock("../lib/image-crop", () => ({ cropImageRegion }));

import { ParagraphCropPreview } from "./ParagraphCropPreview";

describe("ParagraphCropPreview", () => {
  afterEach(() => vi.restoreAllMocks());

  it("按片段页序加载 ai 图片、裁图并清理临时资源", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(new Blob(["page"])));
    const close = vi.fn();
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 1000, height: 1500, close })));
    const createObjectURL = vi.spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:crop-1")
      .mockReturnValueOnce("blob:crop-2");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

    const { unmount } = render(<ParagraphCropPreview
      reviewId="review-1"
      paragraphNumber={1}
      images={[{ id: 7, position: 0 }, { id: 9, position: 1 }]}
      segments={[
        { pageIndex: 0, x: 0.1, y: 0.2, width: 0.5, height: 0.3 },
        { pageIndex: 1, x: 0.1, y: 0.1, width: 0.5, height: 0.2 },
      ]}
    />);

    expect(await screen.findByRole("img", { name: "第 1 段原文裁图，第 1 页" }))
      .toHaveAttribute("src", "blob:crop-1");
    expect(screen.getByRole("img", { name: "第 1 段原文裁图，第 2 页" }))
      .toHaveAttribute("src", "blob:crop-2");
    expect(screen.getByText("第 2 页续")).toBeInTheDocument();
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      1,
      "/api/reviews/review-1/files?imageId=7&variant=ai",
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2,
      "/api/reviews/review-1/files?imageId=9&variant=ai",
    );
    expect(cropImageRegion).toHaveBeenCalledTimes(2);

    unmount();
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:crop-1"));
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:crop-2");
    expect(close).toHaveBeenCalledTimes(2);
    expect(createObjectURL).toHaveBeenCalledTimes(2);
  });

  it("缺少图片页时显示对应段落错误", async () => {
    render(<ParagraphCropPreview
      reviewId="review-1"
      paragraphNumber={3}
      images={[]}
      segments={[{ pageIndex: 1, x: 0.1, y: 0.1, width: 0.5, height: 0.2 }]}
    />);

    expect(await screen.findByRole("alert")).toHaveTextContent("第 3 段第 2 页裁图失败");
  });
});
