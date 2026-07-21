import { redirect } from "next/navigation";

import { requirePageUser } from "@/src/auth/request-auth";
import { AuthUserProvider } from "../components/AuthUserContext";

export default async function ProtectedLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const user = await requirePageUser();
  if (user.mustChangePassword) redirect("/change-password");
  return <AuthUserProvider role={user.role}>{children}</AuthUserProvider>;
}
