import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, apiFetch } from "../lib/api";
import { RequireAuthenticatedUser } from "./RequireAuthenticatedUser";

const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
}));

vi.mock("../lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/api")>();
  return { ...original, apiFetch: vi.fn() };
});

describe("RequireAuthenticatedUser", () => {
  beforeEach(() => {
    replace.mockReset();
    vi.mocked(apiFetch).mockReset();
  });

  it("redirects an unauthenticated browser to login", async () => {
    vi.mocked(apiFetch).mockRejectedValue(new ApiError("Authentication required", 401, "UNAUTHENTICATED"));

    render(<RequireAuthenticatedUser><p>private</p></RequireAuthenticatedUser>);

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
    expect(screen.queryByText("private")).not.toBeInTheDocument();
  });

  it("renders protected content and the user role after authentication", async () => {
    vi.mocked(apiFetch).mockResolvedValue({ id: "teacher-1", username: "teacher", role: "teacher", mustChangePassword: false });

    render(<RequireAuthenticatedUser><p>private</p></RequireAuthenticatedUser>);

    expect(await screen.findByText("private")).toBeInTheDocument();
  });

  it("hides admin-only content from a teacher", async () => {
    vi.mocked(apiFetch).mockResolvedValue({ id: "teacher-1", username: "teacher", role: "teacher", mustChangePassword: false });

    render(<RequireAuthenticatedUser requireAdmin><p>settings</p></RequireAuthenticatedUser>);

    expect(await screen.findByText("没有权限访问此页面")).toBeInTheDocument();
    expect(screen.queryByText("settings")).not.toBeInTheDocument();
  });
});
