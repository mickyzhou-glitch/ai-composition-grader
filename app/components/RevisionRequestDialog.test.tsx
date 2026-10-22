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

  it("requires both trimmed fields and submits trimmed values", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderDialog();

    const reason = screen.getByRole("textbox", { name: "为什么不合适" });
    const changeRequest = screen.getByRole("textbox", { name: "应该怎么改" });
    const submit = screen.getByRole("button", { name: "提交后台修改并继续" });

    expect(submit).toBeDisabled();
    await user.type(reason, "  主题判断不准确  ");
    expect(submit).toBeDisabled();
    await user.type(changeRequest, "  请重新围绕题目生成  ");
    expect(submit).toBeEnabled();
    await user.click(submit);

    expect(onSubmit).toHaveBeenCalledWith({ reason: "主题判断不准确", changeRequest: "请重新围绕题目生成" });
    expect(screen.getByRole("button", { name: "完全不能用" })).toBeEnabled();
    expect(reason).toHaveValue("  主题判断不准确  ");
    expect(changeRequest).toHaveValue("  请重新围绕题目生成  ");
  });

  it("shows character counts, preserves failed input, and locks while submitting", async () => {
    const user = userEvent.setup();
    const view = renderDialog({ submitting: false, error: "退回失败，请重试" });

    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
    expect(screen.getByText("退回后台修改")).toBeVisible();
    expect(screen.getAllByText("0 / 500")).toHaveLength(2);
    expect(screen.getByText("退回失败，请重试")).toBeVisible();
    const reason = screen.getByRole("textbox", { name: "为什么不合适" });
    const changeRequest = screen.getByRole("textbox", { name: "应该怎么改" });
    await user.click(reason);
    await user.keyboard("失败时保留的原因");
    await user.click(changeRequest);
    await user.keyboard("失败时保留的要求");
    expect(reason).toHaveValue("失败时保留的原因");
    expect(changeRequest).toHaveValue("失败时保留的要求");

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
    expect(screen.getByRole("textbox", { name: "为什么不合适" })).toHaveValue("失败时保留的原因");
    expect(screen.getByRole("textbox", { name: "应该怎么改" })).toHaveValue("失败时保留的要求");
  });

  it("完全不能用无需填写两个框，已填内容会原样带回", async () => {
    const user = userEvent.setup();
    const { onReject, onSubmit } = renderDialog();

    await user.click(screen.getByRole("button", { name: "完全不能用" }));
    expect(onReject).toHaveBeenCalledWith({ reason: "", changeRequest: "" });
    expect(onSubmit).not.toHaveBeenCalled();

    await user.type(screen.getByRole("textbox", { name: "为什么不合适" }), "  离题  ");
    await user.type(screen.getByRole("textbox", { name: "应该怎么改" }), "  不必改  ");
    await user.click(screen.getByRole("button", { name: "完全不能用" }));
    expect(onReject).toHaveBeenLastCalledWith({ reason: "离题", changeRequest: "不必改" });
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
