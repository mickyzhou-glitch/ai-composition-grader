import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { BatchReanalysisDialog } from "./BatchReanalysisDialog";

const preview = {
  matched: [
    {
      reviewId: "review-1",
      studentName: "张小明",
      title: "我的周末",
      expectedRevision: 7,
      assignmentId: "assignment-1",
      assignmentUpdatedAt: "2026-08-22T09:30:00.000Z",
    },
    {
      reviewId: "review-2",
      studentName: "李安然",
      title: "我的周末",
      expectedRevision: 3,
      assignmentId: "assignment-1",
      assignmentUpdatedAt: "2026-08-22T09:30:00.000Z",
    },
  ],
  skipped: [{
    reviewId: "review-3",
    studentName: "王若宁",
    title: "春天",
    code: "FRAMEWORK_NOT_FOUND" as const,
    reason: "没有找到同名的已保存题目框架",
  }],
};

const baseProps = {
  open: true,
  preview,
  loading: false,
  submitting: false,
  error: "",
  result: null,
  onClose: vi.fn(),
  onConfirm: vi.fn(),
};

describe("BatchReanalysisDialog", () => {
  it("按框架分组展示匹配项和跳过原因，并提交预览字段", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(<BatchReanalysisDialog {...baseProps} onConfirm={onConfirm} />);

    expect(screen.getByRole("heading", { name: "按最新框架重新分析" })).toBeInTheDocument();
    expect(screen.getByText((_, element) => element instanceof HTMLElement && element.classList.contains("batch-reanalysis-summary"))).toHaveTextContent("共选择 3 篇，可重新分析 2 篇，跳过 1 篇。");
    expect(screen.getByText("没有找到同名的已保存题目框架")).toBeInTheDocument();
    expect(screen.getByText("张小明")).toBeInTheDocument();
    expect(screen.getByText("李安然")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "确认重新分析 2 篇" }));
    expect(onConfirm).toHaveBeenCalledWith([
      {
        reviewId: "review-1",
        expectedRevision: 7,
        assignmentId: "assignment-1",
        expectedAssignmentUpdatedAt: "2026-08-22T09:30:00.000Z",
      },
      {
        reviewId: "review-2",
        expectedRevision: 3,
        assignmentId: "assignment-1",
        expectedAssignmentUpdatedAt: "2026-08-22T09:30:00.000Z",
      },
    ]);
  });

  it("提交中锁定关闭和确认，结果页展示部分成功", () => {
    render(<BatchReanalysisDialog
      {...baseProps}
      submitting
      result={{
        submitted: [{ reviewId: "review-1", jobId: "job-1", revision: 8 }],
        skipped: [{ ...preview.skipped[0], code: "REVISION_CONFLICT", reason: "作文已更新，请重新预览" }],
      }}
    />);

    expect(screen.getByRole("status")).toHaveTextContent("已提交 1 篇重新分析任务，1 篇保留选择");
    expect(screen.getByText("作文已更新，请重新预览")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "完成" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "关闭" })).toBeDisabled();
  });

  it("加载预览时显示状态并禁用确认", () => {
    render(<BatchReanalysisDialog {...baseProps} loading preview={null} />);

    expect(screen.getByRole("status")).toHaveTextContent("正在检查所选作文与最新框架");
    expect(screen.getByRole("button", { name: "关闭" })).toBeDisabled();
  });
});
