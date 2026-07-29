"use client";

import { useEffect, useState, type PropsWithChildren } from "react";
import { useRouter } from "next/navigation";

import { ApiError, apiFetch } from "../lib/api";
import { AuthUserProvider } from "./AuthUserContext";

type CurrentUser = {
  id: string;
  username: string;
  role: "admin" | "teacher";
  mustChangePassword: boolean;
};

export function RequireAuthenticatedUser({ children, requireAdmin = false }: PropsWithChildren<{ requireAdmin?: boolean }>) {
  const router = useRouter();
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    void apiFetch<CurrentUser>("/api/auth/me")
      .then((nextUser) => {
        if (!active) return;
        if (nextUser.mustChangePassword) {
          router.replace("/change-password");
          return;
        }
        setUser(nextUser);
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof ApiError && error.code === "UNAUTHENTICATED") {
          router.replace("/login");
          return;
        }
        setFailed(true);
      });
    return () => { active = false; };
  }, [router]);

  if (failed) return <main className="auth-page"><p className="error-banner" role="alert">认证服务暂时不可用，请稍后重试。</p></main>;
  if (!user) return <main aria-busy="true" />;
  if (requireAdmin && user.role !== "admin") {
    return <main className="auth-page"><p className="error-banner" role="alert">没有权限访问此页面</p></main>;
  }
  return <AuthUserProvider role={user.role}>{children}</AuthUserProvider>;
}
