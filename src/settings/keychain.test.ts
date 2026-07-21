// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  KEYCHAIN_ACCOUNT,
  KEYCHAIN_SERVICE,
  MacOSKeychain,
  MacOSKeychainUnavailableError,
  type KeychainRunner,
} from "./keychain";

describe("MacOSKeychain", () => {
  it("将密钥作为 security 的 -w 参数保存，避免等待交互式输入", async () => {
    const runner = vi.fn<KeychainRunner>().mockResolvedValue({ stdout: "" });
    const keychain = new MacOSKeychain({ runner, platform: "darwin" });

    await keychain.set("sk-not-for-logs");

    expect(runner).toHaveBeenCalledWith(
      "/usr/bin/security",
      [
        "add-generic-password",
        "-U",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        KEYCHAIN_ACCOUNT,
        "-w",
        "sk-not-for-logs",
      ],
    );
  });

  it("读取并清理 security 输出中的换行", async () => {
    const runner = vi.fn<KeychainRunner>().mockResolvedValue({
      stdout: "sk-secret\n",
    });
    const keychain = new MacOSKeychain({ runner, platform: "darwin" });

    await expect(keychain.get()).resolves.toBe("sk-secret");
    expect(runner).toHaveBeenCalledWith("/usr/bin/security", [
      "find-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      KEYCHAIN_ACCOUNT,
      "-w",
    ]);
  });

  it("使用独立参数删除密钥", async () => {
    const runner = vi.fn<KeychainRunner>().mockResolvedValue({ stdout: "" });
    const keychain = new MacOSKeychain({ runner, platform: "darwin" });

    await keychain.delete();

    expect(runner).toHaveBeenCalledWith("/usr/bin/security", [
      "delete-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      KEYCHAIN_ACCOUNT,
    ]);
  });

  it("密钥不存在时返回 null", async () => {
    const notFound = Object.assign(new Error("not found"), { code: 44 });
    const runner = vi.fn<KeychainRunner>().mockRejectedValue(notFound);
    const keychain = new MacOSKeychain({ runner, platform: "darwin" });

    await expect(keychain.get()).resolves.toBeNull();
  });

  it("在非 darwin 平台返回明确错误且不调用 runner", async () => {
    const runner = vi.fn<KeychainRunner>();
    const keychain = new MacOSKeychain({ runner, platform: "linux" });

    await expect(keychain.get()).rejects.toBeInstanceOf(
      MacOSKeychainUnavailableError,
    );
    expect(runner).not.toHaveBeenCalled();
  });
});
