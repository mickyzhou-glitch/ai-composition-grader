import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ExportMenu } from "./ExportMenu";

describe("ExportMenu", () => {
  afterEach(() => vi.restoreAllMocks());

  it("从导出按钮选择 PDF 或 Word 格式", async () => {
    const onExport = vi.fn();
    const user = userEvent.setup();
    render(<ExportMenu onExport={onExport} />);

    const trigger = screen.getByRole("button", { name: "导出" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await user.click(trigger);

    expect(screen.getByRole("menuitem", { name: "PDF" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Word (.docx)" })).toBeVisible();
    await user.click(screen.getByRole("menuitem", { name: "Word (.docx)" }));

    expect(onExport).toHaveBeenCalledWith("docx");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("按 Escape 关闭菜单并把焦点还给导出按钮", async () => {
    const user = userEvent.setup();
    render(<ExportMenu onExport={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "导出" });

    await user.click(trigger);
    screen.getByRole("menuitem", { name: "PDF" }).focus();
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("打开后聚焦首项并支持方向键、Home 和 End 导航", async () => {
    const user = userEvent.setup();
    render(<ExportMenu onExport={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "导出" }));
    const pdfItem = screen.getByRole("menuitem", { name: "PDF" });
    const wordItem = screen.getByRole("menuitem", { name: "Word (.docx)" });

    expect(pdfItem).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(wordItem).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(pdfItem).toHaveFocus();
    await user.keyboard("{End}");
    expect(wordItem).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(pdfItem).toHaveFocus();
    await user.keyboard("{Home}");
    expect(pdfItem).toHaveFocus();
  });

  it("点击菜单外部关闭并把焦点还给导出按钮", async () => {
    const user = userEvent.setup();
    render(<div><ExportMenu onExport={vi.fn()} /><button type="button">其他操作</button></div>);
    const trigger = screen.getByRole("button", { name: "导出" });

    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "其他操作" }));

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("禁用时显示具体原因且不能打开菜单", async () => {
    const user = userEvent.setup();
    render(<ExportMenu
      disabled
      disabledReason="旧版示范段落报告需要完整重新分析后才能导出新格式"
      onExport={vi.fn()}
    />);

    const trigger = screen.getByRole("button", { name: "导出" });
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveAccessibleDescription("旧版示范段落报告需要完整重新分析后才能导出新格式");
    expect(screen.getByText("旧版示范段落报告需要完整重新分析后才能导出新格式")).toBeVisible();
    await user.click(trigger);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
