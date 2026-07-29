import { describe, expect, it } from "vitest";

import { readWorkerEnv } from "./env";

describe("readWorkerEnv", () => {
  it("rejects a deployment without its login encryption secret", () => {
    expect(() => readWorkerEnv({ APP_ORIGIN: "https://app.workers.dev" } as never))
      .toThrow("AUTH_PROOF_ENCRYPTION_KEY is required");
  });
});
