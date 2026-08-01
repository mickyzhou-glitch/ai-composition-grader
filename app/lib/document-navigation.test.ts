import { describe, expect, it, vi } from "vitest";

import { replaceDocument } from "./document-navigation";

describe("replaceDocument", () => {
  it("replaces the current browser document without adding history", () => {
    const replace = vi.fn();

    replaceDocument("/login", { replace });

    expect(replace).toHaveBeenCalledWith("/login");
  });
});
