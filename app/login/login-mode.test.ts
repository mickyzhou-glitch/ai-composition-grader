import { describe, expect, it } from "vitest";

import { shouldUsePasswordProofLogin } from "./login-mode";

describe("password proof login mode", () => {
  it("uses proof login only on the configured Cloudflare workers hostname", () => {
    expect(shouldUsePasswordProofLogin("ai-composition-grader.workers.dev")).toBe(true);
    expect(shouldUsePasswordProofLogin("127.0.0.1")).toBe(false);
  });
});
