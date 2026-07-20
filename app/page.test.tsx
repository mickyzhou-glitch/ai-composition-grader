import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import Home from "./page";

describe("Home", () => {
  it("renders the Chinese teacher-workbench shell", () => {
    render(<Home />);

    expect(
      screen.getByRole("heading", { name: "AI 作业批改助手" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "教师工作台" }),
    ).toBeInTheDocument();
  });
});
