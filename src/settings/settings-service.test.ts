// @vitest-environment node

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initializeSchema } from "../db/init";
import * as schema from "../db/schema";
import { SettingsRepository } from "./settings-repository";
import {
  normalizeBaseUrl,
  SettingsService,
  type SecretStore,
} from "./settings-service";

describe("SettingsService", () => {
  let sqlite: Database.Database;
  let repository: SettingsRepository;
  let secretStore: SecretStore;
  let service: SettingsService;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    initializeSchema(sqlite);
    repository = new SettingsRepository(drizzle(sqlite, { schema }));
    secretStore = {
      set: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue("sk-private"),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    service = new SettingsService(repository, secretStore);
  });

  afterEach(() => sqlite.close());

  it("规范化 base URL、保存密钥到 Keychain，且不落库不回显", async () => {
    await service.save({
      baseUrl: "https://api.example.com/v1///",
      model: "grader-model",
      apiKey: "sk-private",
    });

    expect(secretStore.set).toHaveBeenCalledWith("sk-private");
    await expect(service.get()).resolves.toEqual({
      baseUrl: "https://api.example.com/v1",
      model: "grader-model",
      keyConfigured: true,
    });
    expect(sqlite.prepare("select * from settings").get()).not.toHaveProperty(
      "api_key",
    );
    expect(JSON.stringify(sqlite.prepare("select * from settings").get())).not.toContain(
      "sk-private",
    );
  });

  it("不通过普通设置读取回显 key，内部调用可单独取密钥", async () => {
    await service.save({
      baseUrl: "http://localhost:11434/",
      model: "local-model",
    });

    expect(await service.get()).not.toHaveProperty("apiKey");
    await expect(service.getSecret()).resolves.toBe("sk-private");
  });

  it("传入 null 时删除已配置的密钥", async () => {
    await service.save({
      baseUrl: "https://api.example.com",
      model: "grader-model",
      apiKey: null,
    });

    expect(secretStore.delete).toHaveBeenCalledOnce();
    expect(secretStore.set).not.toHaveBeenCalled();
  });

  it("数据库保存失败时恢复原有密钥", async () => {
    let secret: string | null = "sk-old";
    const statefulStore: SecretStore = {
      get: vi.fn(async () => secret),
      set: vi.fn(async (value: string) => {
        secret = value;
      }),
      delete: vi.fn(async () => {
        secret = null;
      }),
    };
    vi.spyOn(repository, "save").mockImplementation(() => {
      throw new Error("database failed");
    });
    service = new SettingsService(repository, statefulStore);

    await expect(
      service.save({
        baseUrl: "https://api.example.com",
        model: "model",
        apiKey: "sk-new",
      }),
    ).rejects.toThrow("database failed");
    await expect(statefulStore.get()).resolves.toBe("sk-old");
    expect(statefulStore.set).toHaveBeenNthCalledWith(1, "sk-new");
    expect(statefulStore.set).toHaveBeenNthCalledWith(2, "sk-old");
  });

  it("无原有密钥且数据库保存失败时删除新密钥", async () => {
    let secret: string | null = null;
    const statefulStore: SecretStore = {
      get: vi.fn(async () => secret),
      set: vi.fn(async (value: string) => {
        secret = value;
      }),
      delete: vi.fn(async () => {
        secret = null;
      }),
    };
    vi.spyOn(repository, "save").mockImplementation(() => {
      throw new Error("database failed");
    });
    service = new SettingsService(repository, statefulStore);

    await expect(
      service.save({
        baseUrl: "https://api.example.com",
        model: "model",
        apiKey: "sk-new",
      }),
    ).rejects.toThrow("database failed");
    await expect(statefulStore.get()).resolves.toBeNull();
    expect(statefulStore.delete).toHaveBeenCalledOnce();
  });

  it("删除密钥后数据库保存失败时恢复原有密钥", async () => {
    let secret: string | null = "sk-old";
    const statefulStore: SecretStore = {
      get: vi.fn(async () => secret),
      set: vi.fn(async (value: string) => {
        secret = value;
      }),
      delete: vi.fn(async () => {
        secret = null;
      }),
    };
    vi.spyOn(repository, "save").mockImplementation(() => {
      throw new Error("database failed");
    });
    service = new SettingsService(repository, statefulStore);

    await expect(
      service.save({
        baseUrl: "https://api.example.com",
        model: "model",
        apiKey: null,
      }),
    ).rejects.toThrow("database failed");
    await expect(statefulStore.get()).resolves.toBe("sk-old");
    expect(statefulStore.delete).toHaveBeenCalledOnce();
    expect(statefulStore.set).toHaveBeenCalledWith("sk-old");
  });

  it.each([
    "ftp://api.example.com",
    "api.example.com/v1",
    "https://api.example.com/v1?token=secret",
  ])("拒绝无效 base URL: %s", (baseUrl) => {
    expect(() => normalizeBaseUrl(baseUrl)).toThrow();
  });
});
