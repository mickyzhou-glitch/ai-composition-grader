export type UserRole = "admin" | "teacher";

export interface AuthenticatedUser {
  id: string;
  username: string;
  role: UserRole;
  mustChangePassword: boolean;
}

export interface UserRecord extends AuthenticatedUser {
  passwordHash: string;
  disabledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type SessionUser = AuthenticatedUser;

export interface SessionRecord {
  id: string;
  user: SessionUser;
  lastSeenAt: Date;
  expiresAt: Date;
  createdAt: Date;
}

export interface CreateUserInput {
  username: string;
  passwordHash: string;
  role: UserRole;
  mustChangePassword?: boolean;
}

export interface CreateSessionInput {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
}

export interface LoginAttemptInput {
  username: string;
  ipHash: string;
  succeeded: boolean;
}

export interface LoginAttemptRecord {
  id: number;
  normalizedUsername: string;
  ipHash: string;
  succeeded: boolean;
  attemptedAt: Date;
}

export interface LoginFailureQuery {
  username: string;
  ipHash: string;
}

export interface LoginFailureStatus {
  usernameFailures: number;
  ipFailures: number;
  usernameLocked: boolean;
  ipLocked: boolean;
}

export interface RecordedLoginAttemptStatus {
  attempt: LoginAttemptRecord;
  status: LoginFailureStatus;
  lockedBeforeAttempt: boolean;
}

export interface SecurityEventInput {
  userId: string | null;
  eventType: string;
  metadata: Record<string, unknown>;
}

export interface SecurityEventRecord extends SecurityEventInput {
  id: number;
  createdAt: Date;
}
