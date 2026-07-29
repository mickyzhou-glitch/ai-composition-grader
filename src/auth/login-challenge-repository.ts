export interface LoginChallengeRecord {
  id: string;
  normalizedUsername: string;
  salt: string;
  nonce: string;
  ipHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

export interface CreateLoginChallengeInput {
  normalizedUsername: string;
  salt: string;
  nonce: string;
  ipHash: string;
  ttlMs: number;
}

export interface LoginChallengeRepository {
  create(input: CreateLoginChallengeInput): Promise<LoginChallengeRecord>;
  consumeIfActive(challengeId: string, ipHash: string): Promise<LoginChallengeRecord | null>;
}

export interface InMemoryLoginChallengeRepositoryOptions {
  now?: () => Date;
  createId?: () => string;
}

function snapshotDate(value: Date): Date {
  return new Date(value.getTime());
}

function assertBase64Url(value: string, label: string): void {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new TypeError(`${label} must be base64url`);
}

export class InMemoryLoginChallengeRepository implements LoginChallengeRepository {
  private readonly records = new Map<string, LoginChallengeRecord>();
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(options: InMemoryLoginChallengeRepositoryOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => crypto.randomUUID());
  }

  async create(input: CreateLoginChallengeInput): Promise<LoginChallengeRecord> {
    if (!/^[a-f0-9]{64}$/u.test(input.ipHash)) throw new TypeError("IP hash must be a SHA-256 hex hash");
    assertBase64Url(input.salt, "Salt");
    assertBase64Url(input.nonce, "Nonce");
    if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0) throw new TypeError("TTL must be positive");
    const createdAt = snapshotDate(this.now());
    const record: LoginChallengeRecord = {
      id: this.createId(),
      normalizedUsername: input.normalizedUsername,
      salt: input.salt,
      nonce: input.nonce,
      ipHash: input.ipHash,
      expiresAt: new Date(createdAt.getTime() + input.ttlMs),
      consumedAt: null,
      createdAt,
    };
    this.records.set(record.id, record);
    return { ...record, createdAt: snapshotDate(record.createdAt), expiresAt: snapshotDate(record.expiresAt) };
  }

  async consumeIfActive(challengeId: string, ipHash: string): Promise<LoginChallengeRecord | null> {
    const record = this.records.get(challengeId);
    const now = this.now();
    if (!record || record.ipHash !== ipHash || record.consumedAt || record.expiresAt.getTime() <= now.getTime()) return null;
    record.consumedAt = snapshotDate(now);
    return {
      ...record,
      createdAt: snapshotDate(record.createdAt),
      expiresAt: snapshotDate(record.expiresAt),
      consumedAt: snapshotDate(record.consumedAt),
    };
  }
}
