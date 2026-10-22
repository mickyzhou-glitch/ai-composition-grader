import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { RevisionRequestDialog } from "./RevisionRequestDialog";

describe("RevisionRequestDialog", () => {
  function renderDialog(overrides: Partial<React.ComponentProps<typeof RevisionRequestDialog>> = {}) {
    const onClose = vi.fn();
    const onSubmit = vi.fn();
    const onReject = vi.fn();
    const view = render(
      <RevisionRequestDialog
        open
        submitting={false}
        error=""
        onClose={onClose}
        onSubmit={onSubmit}
        onReject={onReject}
        {...overrides}
      />,
    );
    return { onClose, onSubmit, onReject, ...view };
  }

  it("requires at least one trimmed field and submits trimmed values", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderDialog();

    const commonIssue = screen.getByRole("textbox", { name: "结构问题 / 共性问题（仅同名作文）" });
    const contentSuggestion = screen.getByRole("textbox", { name: "内容建议（仅当前文章）" });
    const submit = screen.getByRole("button", { name: "提交后台修改并继续" });

    expect(submit).toBeDisabled();
    expect(screen.getByText(/永久存档为这个题目的长期批改规则/)).toBeVisible();
    expect(screen.getByText(/只对题目相同的作文生效/)).toBeVisible();
    expect(screen.getByText(/只用于本篇重新分析/)).toBeVisible();
    await user.type(commonIssue, "  严格五段  ");
    expect(submit).toBeEnabled();
    await user.click(submit);
    expect(onSubmit).toHaveBeenCalledWith({ commonIssue: "严格五段", contentSuggestion: "" });

    await user.type(contentSuggestion, "  写具体心理  ");
    await user.click(submit);
    expect(onSubmit).toHaveBeenLastCalledWith({ commonIssue: "严格五段", contentSuggestion: "写具体心理" });
    expect(screen.getByRole("button", { name: "完全不能用" })).toBeEnabled();
  });

  it("shows character counts, preserves failed input, and locks while submitting", async () => {
    const user = userEvent.setup();
    const view = renderDialog({ submitting: false, error: "退回失败，请重试" });

    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
    expect(screen.getByText("退回后台修改")).toBeVisible();
    expect(screen.getAllByText("0 / 500")).toHaveLength(2);
    expect(screen.getByText("退回失败，请重试")).toBeVisible();
    const commonIssue = screen.getByRole("textbox", { name: "结构问题 / 共性问题（仅同名作文）" });
    const contentSuggestion = screen.getByRole("textbox", { name: "内容建议（仅当前文章）" });
    await user.click(commonIssue);
    await user.keyboard("失败时保留的规则");
    await user.click(contentSuggestion);
    await user.keyboard("失败时保留的建议");
    expect(commonIssue).toHaveValue("失败时保留的规则");
    expect(contentSuggestion).toHaveValue("失败时保留的建议");

    view.rerender(
      <RevisionRequestDialog
        open
        submitting
        error="退回失败，请重试"
        onClose={vi.fn()}
        onSubmit={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "提交后台修改并继续" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "完全不能用" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "结构问题 / 共性问题（仅同名作文）" })).toHaveValue("失败时保留的规则");
    expect(screen.getByRole("textbox", { name: "内容建议（仅当前文章）" })).toHaveValue("失败时保留的建议");
  });

  it("完全不能用无需填写两个框，已填内容会原样带回", async () => {
    const user = userEvent.setup();
    const { onReject, onSubmit } = renderDialog();

    await user.click(screen.getByRole("button", { name: "完全不能用" }));
    expect(onReject).toHaveBeenCalledWith({ commonIssue: "", contentSuggestion: "" });
    expect(onSubmit).not.toHaveBeenCalled();

    await user.type(screen.getByRole("textbox", { name: "结构问题 / 共性问题（仅同名作文）" }), "  离题  ");
    await user.type(screen.getByRole("textbox", { name: "内容建议（仅当前文章）" }), "  不必改  ");
    await user.click(screen.getByRole("button", { name: "完全不能用" }));
    expect(onReject).toHaveBeenLastCalledWith({ commonIssue: "离题", contentSuggestion: "不必改" });
    expect(screen.getByRole("button", { name: "提交后台修改并继续" })).toBeEnabled();
  });

  it("closes on cancel or Escape only when it is not submitting", async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog();
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    const blockedClose = vi.fn();
    render(
      <RevisionRequestDialog
        open
        submitting
        error=""
        onClose={blockedClose}
        onSubmit={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    await user.keyboard("{Escape}");
    expect(blockedClose).toHaveBeenCalledTimes(0);
  });
});
