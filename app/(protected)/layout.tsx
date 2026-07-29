import { RequireAuthenticatedUser } from "../components/RequireAuthenticatedUser";

export default function ProtectedLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <RequireAuthenticatedUser>{children}</RequireAuthenticatedUser>;
}
