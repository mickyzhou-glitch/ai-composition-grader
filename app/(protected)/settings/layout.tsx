import { notFound } from "next/navigation";

import { requirePageUser } from "@/src/auth/request-auth";

export default async function SettingsLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const user = await requirePageUser();
  if (user.role !== "admin" || user.mustChangePassword) notFound();
  return children;
}
