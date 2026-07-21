// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authService = vi.hoisted(() => ({
  login: vi.fn(),
  authenticateSession: vi.fn(),
  logout: vi.fn(),
  changePassword: vi.fn(),
}));

vi.mock("../runtime/application-services", () => ({
  getApplicationServices: () => ({ authService }),
}));

import { POST as login } from "../../app/api/auth/login/route";
import { POST as logout } from "../../app/api/auth/logout/route";
import { GET as me } from "../../app/api/auth/me/route";

function jsonRequest(url: string, method: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request(url, {
    method,
    headers: { origin: new URL(url).origin, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("authentication route handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AUTH_IP_HMAC_SECRET = "test-independent-secret";
    delete process.env.APP_ORIGIN;
    authService.login.mockResolvedValue({
      rawToken: "raw-session-token",
      user: { id: "user-1", username: "teacher.one", role: "teacher", mustChangePassword: false },
    });
    authService.authenticateSession.mockReturnValue({
      id: "session-1",
      user: { id: "user-1", username: "teacher.one", role: "teacher", mustChangePassword: false },
    });
  });

  afterEach(() => {
    delete process.env.AUTH_IP_HMAC_SECRET;
    delete process.env.APP_ORIGIN;
  });

  it("sets a strict HttpOnly local cookie and returns only the safe user", async () => {
    const response = await login(jsonRequest("http://127.0.0.1:3000/api/auth/login", "POST", { username: "teacher.one", password: "password" }, { "x-real-ip": "203.0.113.7" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: { id: "user-1", username: "teacher.one", role: "teacher", mustChangePassword: false } });
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("zuowen_local_session=raw-session-token");
    expect(cookie).toContain("HttpOnly");
    expect(cookie.toLowerCase()).toContain("samesite=strict");
    expect(cookie).not.toContain("Secure");
    expect(authService.login).toHaveBeenCalledWith(expect.objectContaining({ ipHash: expect.stringMatching(/^[a-f0-9]{64}$/) }));
  });

  it("uses a secure __Host cookie for the configured HTTPS origin", async () => {
    process.env.APP_ORIGIN = "https://grader.example.test";
    const response = await login(jsonRequest("https://grader.example.test/api/auth/login", "POST", { username: "teacher.one", password: "password" }, { "x-real-ip": "203.0.113.7" }));
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("__Host-zuowen_session=raw-session-token");
    expect(cookie).toContain("Secure");
    expect(cookie).not.toContain("Domain=");
  });

  it("rejects a similar but untrusted origin before reading credentials", async () => {
    process.env.APP_ORIGIN = "https://grader.example.test";
    const response = await login(jsonRequest("https://grader.example.test/api/auth/login", "POST", { username: "teacher.one", password: "password" }, { origin: "https://grader.example.test.evil" }));
    expect(response.status).toBe(403);
    expect(authService.login).not.toHaveBeenCalled();
  });

  it("fails safely when the independent IP HMAC secret is missing", async () => {
    delete process.env.AUTH_IP_HMAC_SECRET;
    const response = await login(jsonRequest("http://127.0.0.1:3000/api/auth/login", "POST", { username: "teacher.one", password: "password" }, { "x-real-ip": "203.0.113.7" }));
    expect(response.status).toBe(503);
    expect(authService.login).not.toHaveBeenCalled();
  });

  it("returns 401 for me without a trusted session cookie", async () => {
    const response = await me(new Request("http://127.0.0.1:3000/api/auth/me"));
    expect(response.status).toBe(401);
  });

  it("revokes and clears a local session on logout", async () => {
    const response = await logout(new Request("http://127.0.0.1:3000/api/auth/logout", {
      method: "POST",
      headers: { origin: "http://127.0.0.1:3000", cookie: "zuowen_local_session=raw-session-token" },
    }));
    expect(response.status).toBe(200);
    expect(authService.logout).toHaveBeenCalledWith("raw-session-token");
    expect(response.headers.get("set-cookie")).toContain("zuowen_local_session=");
  });
});
