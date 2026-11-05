import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RevisionPreview } from "./RevisionPreview";

describe("RevisionPreview", () => {
  it("只把增删文字标红并为删除文字使用删除线", () => {
    render(<RevisionPreview runs={[
      { kind: "unchanged", text: "我" },
      { kind: "deleted", text: "很" },
      { kind: "inserted", text: "非常" },
      { kind: "punctuation", text: "！" },
    ]} />);

    expect(screen.getByText("我")).toHaveStyle({ color: "#171717" });
    expect(screen.getByText("很").tagName).toBe("DEL");
    expect(screen.getByText("很")).toHaveStyle({ color: "#C91F32" });
    expect(screen.getByText("非常")).toHaveStyle({ color: "#C91F32" });
    expect(screen.getByText("！")).toHaveStyle({ color: "#171717" });
  });

  it("改后全段预览与导出一致：第 1/2/3 条动作依次波浪、双线、单线，未改动句不划线", () => {
    render(<RevisionPreview sentenceHighlight runs={[
      { kind: "inserted", text: "我心头一颤，", underline: "wave" },
      { kind: "unchanged", text: "眼睛有些湿润。" },
      { kind: "inserted", text: "一缕夕阳洒进来。", underline: "double" },
      { kind: "inserted", text: "我被深深感动。", underline: "single" },
      { kind: "inserted", text: "旧报告改动句。" },
    ]} />);

    expect(screen.getByText("我心头一颤，")).toHaveStyle({ textDecorationStyle: "wavy", color: "#1F4E78" });
    expect(screen.getByText("一缕夕阳洒进来。")).toHaveStyle({ textDecorationStyle: "double" });
    expect(screen.getByText("我被深深感动。")).toHaveStyle({ textDecorationStyle: "solid" });
    expect(screen.getByText("我心头一颤，").style.textDecorationStyle).toBe("wavy");
    expect(screen.getByText("一缕夕阳洒进来。").style.textDecorationStyle).toBe("double");
    expect(screen.getByText("我被深深感动。")).toHaveAttribute("data-underline", "single");
    expect(screen.getByText("旧报告改动句。")).toHaveAttribute("data-underline", "single");
    expect(screen.getByText("眼睛有些湿润。")).not.toHaveAttribute("data-underline");
    expect(screen.getByText("眼睛有些湿润。").style.textDecoration).toBe("");
  });
});
