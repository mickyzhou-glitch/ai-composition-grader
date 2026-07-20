import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { PhotoAnnotationEditor, normalizedPoint } from "./PhotoAnnotationEditor";

describe("PhotoAnnotationEditor", () => {
  it("将指针坐标限制在 0..1", () => {
    expect(normalizedPoint({ clientX: -10, clientY: 150 }, { left: 0, top: 0, width: 100, height: 100 }))
      .toEqual({ x: 0, y: 1 });
  });

  it("点击图片新增批注，并可编辑、切换亮点和删除", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <PhotoAnnotationEditor
        imageUrl="/api/reviews/r1/files?path=images%2Fa.jpg"
        pageIndex={0}
        annotations={[]}
        onChange={onChange}
      />,
    );
    const canvas = screen.getByLabelText("第 1 页作文批注画布");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON: () => ({}),
    });
    fireEvent.click(canvas, { clientX: 50, clientY: 75 });
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ pageIndex: 0, x: 0.25, y: 0.75, category: "expression" }),
    ]);

    const annotation = onChange.mock.calls[0][0][0];
    rerender(
      <PhotoAnnotationEditor imageUrl="image.jpg" pageIndex={0} annotations={[annotation]} onChange={onChange} />,
    );
    fireEvent.change(screen.getByLabelText("批注内容 1"), { target: { value: "表达更具体" } });
    expect(onChange).toHaveBeenLastCalledWith([expect.objectContaining({ comment: "表达更具体" })]);
    await user.click(screen.getByLabelText("标记为亮点 1"));
    expect(onChange).toHaveBeenLastCalledWith([expect.objectContaining({ isHighlight: true })]);
    await user.click(screen.getByRole("button", { name: "删除批注 1" }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });
});
