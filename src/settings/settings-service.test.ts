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

  it("独立保存视觉与内容模型配置", async () => {
    await service.save({
      baseUrl: "https://vision.example/v1",
      model: "vision-model",
      apiKey: "vision-secret",
    }, "vision");
    await service.save({
      baseUrl: "https://content.example/v1",
      model: "content-model",
      apiKey: "content-secret",
    }, "content");

    await expect(service.get("vision")).resolves.toMatchObject({
      baseUrl: "https://vision.example/v1",
      model: "vision-model",
    });
    await expect(service.get("content")).resolves.toMatchObject({
      baseUrl: "https://content.example/v1",
      model: "content-model",
    });
    expect(repository.get("vision")?.model).toBe("vision-model");
    expect(repository.get("content")?.model).toBe("content-model");
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

  it("空 apiKey 在访问 Keychain 前就被拒绝", async () => {
    await expect(
      service.save({
        baseUrl: "https://api.example.com",
        model: "model",
        apiKey: "",
      }),
    ).rejects.toThrow("apiKey must not be empty");
    expect(secretStore.get).not.toHaveBeenCalled();
  });

  it("串行化并发 save 的保存与失败补偿", async () => {
    let secret: string | null = "sk-old";
    let releaseFirstSet = () => {};
    let markFirstSetStarted = () => {};
    const firstSetStarted = new Promise<void>((resolve) => {
      markFirstSetStarted = resolve;
    });
    const firstSetGate = new Promise<void>((resolve) => {
      releaseFirstSet = resolve;
    });
    const statefulStore: SecretStore = {
      get: vi.fn(async () => secret),
      set: vi.fn(async (value: string) => {
        secret = value;
        if (value === "sk-first") {
          markFirstSetStarted();
          await firstSetGate;
        }
      }),
      delete: vi.fn(async () => {
        secret = null;
      }),
    };
    const saveSettings = repository.save.bind(repository);
    vi.spyOn(repository, "save").mockImplementation((input) => {
      if (input.model === "first") throw new Error("first database failed");
      return saveSettings(input);
    });
    service = new SettingsService(repository, statefulStore);

    const first = service.save({
      baseUrl: "https://api.example.com",
      model: "first",
      apiKey: "sk-first",
    });
    await firstSetStarted;
    const second = service.save({
      baseUrl: "https://api.example.com",
      model: "second",
      apiKey: "sk-second",
    });
    await Promise.resolve();

    expect(statefulStore.get).toHaveBeenCalledTimes(1);
    releaseFirstSet();
    await expect(first).rejects.toThrow("first database failed");
    await expect(second).resolves.toMatchObject({ model: "second" });
    expect(secret).toBe("sk-second");
  });

  it("getRuntimeConfig 与 save 共用队列，绝不拼出旧 URL 和新 key", async () => {
    repository.save({ baseUrl: "https://old.example/v1", model: "old-model" });
    let secret = "sk-old";
    let releaseSet = () => {};
    let markSetStarted = () => {};
    const setStarted = new Promise<void>((resolve) => {
      markSetStarted = resolve;
    });
    const setGate = new Promise<void>((resolve) => {
      releaseSet = resolve;
    });
    const statefulStore: SecretStore = {
      get: vi.fn(async () => secret),
      set: vi.fn(async (value) => {
        secret = value;
        markSetStarted();
        await setGate;
      }),
      delete: vi.fn(async () => {
        secret = "";
      }),
    };
    service = new SettingsService(repository, statefulStore);

    const saving = service.save({
      baseUrl: "https://new.example/v1",
      model: "new-model",
      apiKey: "sk-new",
    });
    await setStarted;
    let snapshotSettled = false;
    const snapshot = service.getRuntimeConfig().then((value) => {
      snapshotSettled = true;
      return value;
    });
    await Promise.resolve();

    expect(snapshotSettled).toBe(false);
    releaseSet();
    await saving;
    await expect(snapshot).resolves.toEqual({
      baseUrl: "https://new.example/v1",
      model: "new-model",
      apiKey: "sk-new",
    });
  });

  it("testCandidate 将取 key、连接测试和可选保存放在同一队列操作中", async () => {
    repository.save({ baseUrl: "https://old.example/v1", model: "old-model" });
    let secret = "sk-old";
    let releaseOldTest = () => {};
    let markOldTestStarted = () => {};
    const oldTestStarted = new Promise<void>((resolve) => {
      markOldTestStarted = resolve;
    });
    const oldTestGate = new Promise<void>((resolve) => {
      releaseOldTest = resolve;
    });
    const statefulStore: SecretStore = {
      get: vi.fn(async () => secret),
      set: vi.fn(async (value) => {
        secret = value;
      }),
      delete: vi.fn(async () => {
        secret = "";
      }),
    };
    service = new SettingsService(repository, statefulStore);
    const oldTester = vi.fn(async (candidate) => {
      expect(candidate).toEqual({
        baseUrl: "https://old.example/v1",
        model: "old-model",
        apiKey: "sk-old",
      });
      markOldTestStarted();
      await oldTestGate;
    });
    const newTester = vi.fn(async () => {});

    const testingOld = service.testCandidate(
      { baseUrl: "https://old.example/v1", model: "old-model" },
      oldTester,
      false,
    );
    await oldTestStarted;
    const savingNew = service.testCandidate(
      {
        baseUrl: "https://new.example/v1",
        model: "new-model",
        apiKey: "sk-new",
      },
      newTester,
      true,
    );
    await Promise.resolve();

    expect(newTester).not.toHaveBeenCalled();
    releaseOldTest();
    await testingOld;
    await expect(savingNew).resolves.toEqual({
      baseUrl: "https://new.example/v1",
      model: "new-model",
      keyConfigured: true,
    });
    expect(newTester).toHaveBeenCalledWith({
      baseUrl: "https://new.example/v1",
      model: "new-model",
      apiKey: "sk-new",
    });
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
