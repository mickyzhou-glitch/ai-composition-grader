import { describe, expect, it } from "vitest";

import { openSetting, sealSetting } from "./settings-secret";
import { toBase64Url } from "../auth/password-proof";

describe("settings secret", () => {
  it("encrypts a value without retaining plaintext", async () => {
    const key = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const sealed = await sealSetting("sk-example-secret", key);

    expect(sealed).not.toContain("sk-example-secret");
    await expect(openSetting(sealed, key)).resolves.toBe("sk-example-secret");
  });

  it("rejects a value opened with another key", async () => {
    const sealed = await sealSetting("sk-example-secret", toBase64Url(crypto.getRandomValues(new Uint8Array(32))));

    await expect(openSetting(sealed, toBase64Url(crypto.getRandomValues(new Uint8Array(32))))).rejects.toThrow();
  });
});
