"use client";

import { createContext, useContext } from "react";

type AuthRole = "admin" | "teacher";
const AuthRoleContext = createContext<AuthRole | undefined>(undefined);

export function AuthUserProvider({ role, children }: { role: AuthRole; children: React.ReactNode }) {
  return <AuthRoleContext.Provider value={role}>{children}</AuthRoleContext.Provider>;
}
export function useAuthRole(): AuthRole | undefined {
  return useContext(AuthRoleContext);
}
