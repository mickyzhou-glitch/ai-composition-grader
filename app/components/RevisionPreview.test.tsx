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
});
