import { describe, expect, it } from "vitest";

import { shouldUsePasswordProofLogin } from "./login-mode";

describe("password proof login mode", () => {
  it("uses proof login on cloud and local Worker hostnames", () => {
    expect(shouldUsePasswordProofLogin("ai-composition-grader.workers.dev")).toBe(true);
    expect(shouldUsePasswordProofLogin("grader.example.com")).toBe(true);
    expect(shouldUsePasswordProofLogin("127.0.0.1")).toBe(true);
    expect(shouldUsePasswordProofLogin("localhost")).toBe(true);
  });
});
