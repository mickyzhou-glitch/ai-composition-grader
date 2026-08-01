import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ParentFeedback } from "@/src/domain/contracts";
import { ParentFeedbackEditor } from "./ParentFeedbackEditor";

const feedbacks: ParentFeedback[] = [
  { style: "warm", title: "亲切详细", content: "家长您好，孩子这次进步明显。" },
  { style: "professional", title: "专业清晰", content: "本次作文结构完整，建议加强细节描写。" },
  { style: "concise", title: "简短微信版", content: "孩子有进步，建议补充细节。" },
];

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

function setClipboard(clipboard?: Clipboard) {
  if (clipboard) {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
    return;
  }
  Reflect.deleteProperty(navigator, "clipboard");
}

function FeedbackHarness({
  initialFeedbacks = feedbacks,
  savedFeedbacks = feedbacks,
  disabled = false,
  onChange = vi.fn(),
  onCopySuccess = vi.fn(),
  onCopyError = vi.fn(),
}: {
  initialFeedbacks?: ParentFeedback[];
  savedFeedbacks?: ParentFeedback[];
  disabled?: boolean;
  onChange?: (next: ParentFeedback[]) => void;
  onCopySuccess?: () => void;
  onCopyError?: () => void;
}) {
  const [currentFeedbacks, setCurrentFeedbacks] = useState(initialFeedbacks);

  return (
    <ParentFeedbackEditor
      feedbacks={currentFeedbacks}
      savedFeedbacks={savedFeedbacks}
      disabled={disabled}
      onChange={(next) => {
        setCurrentFeedbacks(next);
        onChange(next);
      }}
      onCopySuccess={onCopySuccess}
      onCopyError={onCopyError}
    />
  );
}

describe("ParentFeedbackEditor", () => {
  beforeEach(() => {
    setClipboard();
  });

  afterEach(() => {
    if (originalClipboard) {
      Object.defineProperty(navigator, "clipboard", originalClipboard);
    } else {
      Reflect.deleteProperty(navigator, "clipboard");
    }
    vi.restoreAllMocks();
  });

  it("默认展示亲切详细标签、正文和三个标签", () => {
    render(<FeedbackHarness />);

    expect(screen.getByRole("region", { name: "给家长的反馈" })).toBeInTheDocument();
    expect(screen.getByText("已生成 3 份，可选择后修改")).toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(screen.getByRole("tab", { name: "亲切详细" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("亲切详细家长反馈")).toHaveValue(feedbacks[0].content);
  });

  it("切换专业清晰后显示对应正文", async () => {
    const user = userEvent.setup();
    render(<FeedbackHarness />);

    await user.click(screen.getByRole("tab", { name: "专业清晰" }));

    expect(screen.getByRole("tab", { name: "专业清晰" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("专业清晰家长反馈")).toHaveValue(feedbacks[1].content);
  });

  it("编辑专业清晰时只回传第二份被更新的反馈", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<FeedbackHarness onChange={onChange} />);

    await user.click(screen.getByRole("tab", { name: "专业清晰" }));
    fireEvent.change(screen.getByLabelText("专业清晰家长反馈"), { target: { value: "修改后的专业反馈" } });

    expect(screen.getByLabelText("专业清晰家长反馈")).toHaveValue("修改后的专业反馈");
    expect(onChange).toHaveBeenLastCalledWith([
      feedbacks[0],
      { ...feedbacks[1], content: "修改后的专业反馈" },
      feedbacks[2],
    ]);
  });

  it("恢复原文只恢复当前反馈，保留其他反馈的修改", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const modifiedFeedbacks = [
      { ...feedbacks[0], content: "已修改的亲切反馈" },
      { ...feedbacks[1], content: "已修改的专业反馈" },
      feedbacks[2],
    ];
    render(<FeedbackHarness initialFeedbacks={modifiedFeedbacks} onChange={onChange} />);

    await user.click(screen.getByRole("tab", { name: "专业清晰" }));
    await user.click(screen.getByRole("button", { name: "恢复原文" }));

    expect(screen.getByLabelText("专业清晰家长反馈")).toHaveValue(feedbacks[1].content);
    expect(onChange).toHaveBeenLastCalledWith([
      modifiedFeedbacks[0],
      feedbacks[1],
      feedbacks[2],
    ]);
  });

  it("复制时只写入当前正文并通知成功", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const onCopySuccess = vi.fn();
    const user = userEvent.setup();
    setClipboard({ writeText } as unknown as Clipboard);
    render(<FeedbackHarness onCopySuccess={onCopySuccess} />);

    await user.click(screen.getByRole("tab", { name: "专业清晰" }));
    await user.click(screen.getByRole("button", { name: "复制反馈" }));

    expect(writeText).toHaveBeenCalledWith(feedbacks[1].content);
    expect(onCopySuccess).toHaveBeenCalledOnce();
  });

  it("复制失败或剪贴板不可用时通知失败且保留正文", async () => {
    const onCopyError = vi.fn();
    const user = userEvent.setup();
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    setClipboard({ writeText } as unknown as Clipboard);
    render(<FeedbackHarness onCopyError={onCopyError} />);

    await user.click(screen.getByRole("button", { name: "复制反馈" }));
    expect(onCopyError).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("亲切详细家长反馈")).toHaveValue(feedbacks[0].content);

    setClipboard();
    await user.click(screen.getByRole("button", { name: "复制反馈" }));
    expect(onCopyError).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText("亲切详细家长反馈")).toHaveValue(feedbacks[0].content);
  });

  it("没有反馈时显示空状态且不显示编辑控件", () => {
    render(<FeedbackHarness initialFeedbacks={[]} savedFeedbacks={[]} />);

    expect(screen.getByRole("region", { name: "给家长的反馈" })).toBeInTheDocument();
    expect(screen.getByText("暂无家长反馈，请重新分析作文后生成。")).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "复制反馈" })).not.toBeInTheDocument();
  });

  it("禁用编辑和操作但仍允许切换标签查看内容", async () => {
    const user = userEvent.setup();
    render(<FeedbackHarness disabled />);

    expect(screen.getByLabelText("亲切详细家长反馈")).toBeDisabled();
    expect(screen.getByRole("button", { name: "恢复原文" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "复制反馈" })).toBeDisabled();
    expect(screen.getByRole("tab", { name: "专业清晰" })).not.toBeDisabled();

    await user.click(screen.getByRole("tab", { name: "专业清晰" }));
    expect(screen.getByLabelText("专业清晰家长反馈")).toHaveValue(feedbacks[1].content);
  });

  it("当前标签被移除时回退到新列表的第一项", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ParentFeedbackEditor
        feedbacks={feedbacks}
        savedFeedbacks={feedbacks}
        disabled={false}
        onChange={vi.fn()}
        onCopySuccess={vi.fn()}
        onCopyError={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "专业清晰" }));
    rerender(
      <ParentFeedbackEditor
        feedbacks={[feedbacks[2], feedbacks[0]]}
        savedFeedbacks={feedbacks}
        disabled={false}
        onChange={vi.fn()}
        onCopySuccess={vi.fn()}
        onCopyError={vi.fn()}
      />,
    );

    const tabs = screen.getAllByRole("tab");
    expect(tabs.filter((tab) => tab.getAttribute("aria-selected") === "true")).toEqual([tabs[0]]);
    expect(screen.getByLabelText("简短微信版家长反馈")).toHaveValue(feedbacks[2].content);
  });

  it("每个标签都关联页面中存在的面板", () => {
    render(<FeedbackHarness />);

    for (const tab of screen.getAllByRole("tab")) {
      const panelId = tab.getAttribute("aria-controls");
      expect(panelId).toBeTruthy();
      expect(document.getElementById(panelId!)).toHaveAttribute("role", "tabpanel");
    }
  });

  it("多个编辑器实例使用互不冲突的标签和面板 ID", () => {
    render(
      <>
        <FeedbackHarness />
        <FeedbackHarness />
      </>,
    );

    const tabs = screen.getAllByRole("tab");
    const tabIds = tabs.map((tab) => tab.id);
    const panelIds = tabs.map((tab) => tab.getAttribute("aria-controls"));

    expect(new Set(tabIds)).toHaveLength(tabIds.length);
    expect(new Set(panelIds)).toHaveLength(panelIds.length);
  });
});
