import { fireEvent, within, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { appendRuleText, RevisionRequestDialog } from "./RevisionRequestDialog";

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

  it("requires at least one nonblank field and submits the original values", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderDialog();

    const commonIssue = screen.getByRole("textbox", { name: "结构问题 / 共性问题（仅同名作文）" });
    const contentSuggestion = screen.getByRole("textbox", { name: "内容建议（仅当前文章）" });
    const submit = screen.getByRole("button", { name: "提交后台修改并继续" });

    expect(submit).toBeDisabled();
    expect(screen.getByText(/审批通过后才对同名作文生效/)).toBeVisible();
    expect(screen.getByText(/才对同名作文生效/)).toBeVisible();
    expect(screen.getByText(/只用于本篇重新分析/)).toBeVisible();
    await user.type(commonIssue, "  严格五段  ");
    expect(submit).toBeEnabled();
    await user.click(submit);
    expect(onSubmit).toHaveBeenCalledWith({ commonIssue: "  严格五段  ", contentSuggestion: "" });

    await user.type(contentSuggestion, "  写具体心理  ");
    await user.click(submit);
    expect(onSubmit).toHaveBeenLastCalledWith({ commonIssue: "  严格五段  ", contentSuggestion: "  写具体心理  " });
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
    expect(onReject).toHaveBeenLastCalledWith({ commonIssue: "  离题  ", contentSuggestion: "  不必改  " });
    expect(screen.getByRole("button", { name: "提交后台修改并继续" })).toBeEnabled();
  });

  it("closes on cancel or Escape only when it is not submitting", async () => {
    const user = userEvent.setup();
    const { onClose, rerender } = renderDialog();
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);

    const blockedClose = vi.fn();
    rerender(
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

  it("点选规则仅追加原话，可继续手改，重复点击不会删除或重复原文", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<RevisionRequestDialog open standingRules={["开头点题。", "结尾升华。"]} submitting={false} error="" onClose={vi.fn()} onSubmit={onSubmit} onReject={vi.fn()} />);
    const field = screen.getByRole("textbox", { name: "结构问题 / 共性问题（仅同名作文）" });
    const rules = screen.getByRole("group", { name: "已通过的长期规则" });
    await user.type(field, "老师先写的意见  ");
    await user.click(within(rules).getByRole("button", { name: "追加规则：开头点题。" }));
    await user.click(within(rules).getByRole("button", { name: "追加规则：结尾升华。" }));
    expect(field).toHaveValue("老师先写的意见  \n开头点题。\n结尾升华。");
    await user.click(within(rules).getByRole("button", { name: "追加规则：开头点题。" }));
    expect(field).toHaveValue("老师先写的意见  \n开头点题。\n结尾升华。");
    await user.clear(field);
    await user.type(field, "开头点题，并写清时间。\n第三段写细节");
    await user.click(within(rules).getByRole("button", { name: "追加规则：开头点题。" }));
    expect(field).toHaveValue("开头点题，并写清时间。\n第三段写细节\n开头点题。");
    await user.click(screen.getByRole("button", { name: "提交后台修改并继续" }));
    expect(onSubmit).toHaveBeenCalledWith({ commonIssue: "开头点题，并写清时间。\n第三段写细节\n开头点题。", contentSuggestion: "" });
  });

  it("没有已通过规则时不显示选项", () => {
    render(<RevisionRequestDialog open submitting={false} error="" onClose={vi.fn()} onSubmit={vi.fn()} onReject={vi.fn()} />);
    expect(screen.queryByRole("group", { name: "已通过的长期规则" })).not.toBeInTheDocument();
  });

  it("传入本篇历史退回意见时自动回显到内容建议框并提供追加按钮", () => {
    renderDialog({ essayOpinions: ["第二段心理描写太简略", "结尾扣回主题"] });
    expect(screen.getByRole("group", { name: "本篇历史退回意见" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "内容建议（仅当前文章）" })).toHaveValue("第二段心理描写太简略\n结尾扣回主题");
  });

  it("追加保留手写空白与规则换行，仅去重完全相同的整条规则", () => {
    expect(appendRuleText("", "a")).toBe("a");
    expect(appendRuleText("手写  \n", "第一段。\n保留  停顿！")).toBe("手写  \n第一段。\n保留  停顿！");
    expect(appendRuleText("手写\n第一段。\n保留  停顿！", "第一段。\n保留  停顿！")).toBe("手写\n第一段。\n保留  停顿！");
    expect(appendRuleText("开头点题。", "开头点题")).toBe("开头点题。\n开头点题");
  });

  it("追加超长规则时提示且完整保留两个框，手改后仍能追加", async () => {
    const user = userEvent.setup();
    renderDialog({ standingRules: ["细节".repeat(260), "结尾点题。"] });
    const common = screen.getByRole("textbox", { name: "结构问题 / 共性问题（仅同名作文）" });
    const content = screen.getByRole("textbox", { name: "内容建议（仅当前文章）" });
    await user.type(common, "先写的原话  ");
    await user.type(content, "仅本篇建议");
    await user.click(screen.getByRole("button", { name: `追加规则：${"细节".repeat(260)}` }));
    expect(screen.getByRole("alert")).toHaveTextContent("追加后超过 500 字");
    expect(common).toHaveValue("先写的原话  ");
    expect(content).toHaveValue("仅本篇建议");
    await user.clear(common);
    await user.type(common, "缩短后的意见");
    await user.click(screen.getByRole("button", { name: "追加规则：结尾点题。" }));
    expect(common).toHaveValue("缩短后的意见\n结尾点题。");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("超长内容也不能经完全不能用按钮绕过校验", () => {
    const { onReject } = renderDialog();
    fireEvent.change(screen.getByRole("textbox", { name: "内容建议（仅当前文章）" }), { target: { value: "长".repeat(501) } });
    fireEvent.click(screen.getByRole("button", { name: "完全不能用" }));
    expect(onReject).not.toHaveBeenCalled();
  });

  it("弹窗置于页面容器外，锁定页面滚动，Tab 不逃出弹窗且关闭后恢复焦点", async () => {
    const user = userEvent.setup();
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    const previousOverflow = document.body.style.overflow;
    const { container, unmount } = renderDialog();
    const dialog = screen.getByRole("dialog");
    const common = screen.getByRole("textbox", { name: "结构问题 / 共性问题（仅同名作文）" });
    expect(container).not.toContainElement(dialog);
    expect(document.body.style.overflow).toBe("hidden");
    expect(common).toHaveFocus();
    await user.type(common, "规则");
    expect(common).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "提交后台修改并继续" })).toHaveFocus();
    await user.tab();
    expect(common).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("textbox", { name: "内容建议（仅当前文章）" })).toHaveFocus();
    unmount();
    expect(document.body.style.overflow).toBe(previousOverflow);
    expect(trigger).toHaveFocus();
    trigger.remove();
  });
});
