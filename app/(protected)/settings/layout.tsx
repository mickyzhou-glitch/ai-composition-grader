import { RequireAuthenticatedUser } from "../../components/RequireAuthenticatedUser";

export default function SettingsLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <RequireAuthenticatedUser requireAdmin>{children}</RequireAuthenticatedUser>;
}
