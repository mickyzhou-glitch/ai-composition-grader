// @vitest-environment node

import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

import { openAppDatabase } from "./client";

describe("openAppDatabase", () => {
  it("schema 初始化失败时关闭已打开的 SQLite 连接", () => {
    const close = vi.spyOn(Database.prototype, "close");

    expect(() =>
      openAppDatabase(":memory:", {
        initialize: () => {
          throw new Error("init failed");
        },
      }),
    ).toThrow("init failed");
    expect(close).toHaveBeenCalledOnce();

    close.mockRestore();
  });
});
