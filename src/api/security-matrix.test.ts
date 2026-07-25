// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const services = vi.hoisted(() => ({
  authService: {
    authenticateSession: vi.fn(),
    refreshSessionIfNeeded: vi.fn(),
  },
  reviewService: {
    list: vi.fn(),
    create: vi.fn(),
    get: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  settingsService: {
    get: vi.fn(),
    testCandidate: vi.fn(),
  },
  imageService: {},
  pdfService: {},
}));

vi.mock("../runtime/application-services", () => ({
  getApplicationServices: () => services,
}));

import { GET as getSettings, PUT as putSettings } from "../../app/api/settings/route";
import { GET as listReviews, POST as createReview } from "../../app/api/reviews/route";

const origin = "http://127.0.0.1:3001";

function request(path: string, init: RequestInit = {}, cookie?: string): Request {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("cookie", `zuowen_local_session=${cookie}`);
  return new Request(`${origin}${path}`, { ...init, headers });
}

function session(user: { id: string; role: "admin" | "teacher"; mustChangePassword?: boolean }) {
  services.authService.authenticateSession.mockReturnValue({
    id: "session-1",
    lastSeenAt: new Date(),
    user: { username: user.id, mustChangePassword: false, ...user },
  });
}

describe("业务 API 安全矩阵", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    services.authService.authenticateSession.mockReturnValue(null);
    services.authService.refreshSessionIfNeeded.mockReturnValue(null);
    services.reviewService.list.mockReturnValue([]);
    services.settingsService.get.mockResolvedValue({ baseUrl: "https://ai.test/v1", model: "m", keyConfigured: false });
    services.settingsService.testCandidate.mockResolvedValue({ baseUrl: "https://ai.test/v1", model: "m", keyConfigured: true });
    delete process.env.APP_ORIGIN;
    (process.env as Record<string, string | undefined>).NODE_ENV = "test";
  });

  it("无 Cookie、失效 Cookie 都在业务执行前返回 401", async () => {
    expect((await listReviews(request("/api/reviews"))).status).toBe(401);
    expect((await listReviews(request("/api/reviews", {}, "stale"))).status).toBe(401);
    expect(services.reviewService.list).not.toHaveBeenCalled();
  });

  it("首次改密账号不能调用业务 API，但认证白名单仍可用", async () => {
    session({ id: "teacher-1", role: "teacher", mustChangePassword: true });
    const response = await listReviews(request("/api/reviews", {}, "raw"));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "PASSWORD_CHANGE_REQUIRED" } });
    expect(services.reviewService.list).not.toHaveBeenCalled();
  });

  it("写请求必须通过精确同源 Origin 校验", async () => {
    session({ id: "teacher-1", role: "teacher" });
    const response = await createReview(request("/api/reviews", {
      method: "POST",
      headers: { origin: "http://evil.example" },
      body: JSON.stringify({}),
    }, "raw"));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "UNTRUSTED_ORIGIN" } });
    expect(services.reviewService.create).not.toHaveBeenCalled();
  });

  it("生产环境缺少 APP_ORIGIN 时拒绝写请求", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    session({ id: "admin-1", role: "admin" });
    const response = await putSettings(request("/api/settings", {
      method: "PUT",
      headers: { origin },
      body: JSON.stringify({ baseUrl: "https://ai.test/v1", model: "m" }),
    }, "raw"));
    expect(response.status).toBe(403);
    expect(services.settingsService.testCandidate).not.toHaveBeenCalled();
  });

  it("教师不能读取或写入设置，管理员可以读取并保存", async () => {
    session({ id: "teacher-1", role: "teacher" });
    expect((await getSettings(request("/api/settings", {}, "raw"))).status).toBe(403);

    session({ id: "admin-1", role: "admin" });
    expect((await getSettings(request("/api/settings", {}, "raw"))).status).toBe(200);
    const saved = await putSettings(request("/api/settings", {
      method: "PUT",
      headers: { origin },
      body: JSON.stringify({ baseUrl: "https://ai.test/v1", model: "m" }),
    }, "raw"));
    expect(saved.status).toBe(200);
    expect(services.settingsService.testCandidate).toHaveBeenCalled();
  });

  it("跨租户列表只使用当前会话 owner，内部错误不泄露实现细节", async () => {
    session({ id: "teacher-2", role: "teacher" });
    services.reviewService.list.mockImplementation(() => {
      throw new Error("SQLITE_ERROR /Users/private/api-key=secret");
    });
    const response = await listReviews(request("/api/reviews", {}, "raw"));
    expect(response.status).toBe(500);
    const text = JSON.stringify(await response.json());
    expect(text).not.toContain("SQLITE_ERROR");
    expect(text).not.toContain("/Users/private");
    expect(text).not.toContain("api-key=secret");
    expect(services.reviewService.list).toHaveBeenCalledWith("teacher-2");
  });
});
