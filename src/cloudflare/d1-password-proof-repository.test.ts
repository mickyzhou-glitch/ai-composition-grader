import { describe, expect, it, vi } from "vitest";

import { D1PasswordProofRepository } from "./d1-password-proof-repository";

describe("D1PasswordProofRepository", () => {
  it("queries a proof only through the user join", async () => {
    const first = vi.fn().mockResolvedValue(null);
    const bind = vi.fn(() => ({ first }));
    const prepare = vi.fn(() => ({ bind }));
    const repository = new D1PasswordProofRepository({ prepare } as never);

    await expect(repository.findByUsername("teacher-1")).resolves.toBeNull();
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("INNER JOIN user_password_proofs"));
    expect(bind).toHaveBeenCalledWith("teacher-1");
  });

  it("loads the legacy user and optional proof in one login-candidate query", async () => {
    const first = vi.fn().mockResolvedValue({
      id: "u1",
      username: "teacher-1",
      role: "teacher",
      must_change_password: 0,
      disabled_at: null,
      password_hash: "legacy-hash",
      salt: null,
      sealed_verifier: null,
    });
    const bind = vi.fn(() => ({ first }));
    const prepare = vi.fn(() => ({ bind }));
    const repository = new D1PasswordProofRepository({ prepare } as never);

    await expect(repository.findLoginCandidateByUsername("teacher-1")).resolves.toMatchObject({
      proof: null,
      legacy: { user: { id: "u1", username: "teacher-1" }, passwordHash: "legacy-hash" },
    });
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("LEFT JOIN user_password_proofs"));
    expect(bind).toHaveBeenCalledWith("teacher-1");
  });

  it("maps a joined modern proof from the login-candidate query", async () => {
    const sealed = { ciphertext: "ciphertext", iv: "iv", version: 1 };
    const first = vi.fn().mockResolvedValue({
      id: "u1",
      username: "teacher-1",
      role: "teacher",
      must_change_password: 1,
      disabled_at: null,
      password_hash: "legacy-hash",
      salt: "c2FsdA",
      sealed_verifier: JSON.stringify(sealed),
    });
    const bind = vi.fn(() => ({ first }));
    const repository = new D1PasswordProofRepository({ prepare: vi.fn(() => ({ bind })) } as never);

    await expect(repository.findLoginCandidateByUsername("teacher-1")).resolves.toMatchObject({
      proof: {
        user: { id: "u1", username: "teacher-1", mustChangePassword: true },
        salt: "c2FsdA",
        sealed,
      },
      legacy: { passwordHash: "legacy-hash" },
    });
  });

  it("inserts a migrated proof only when the user has no proof yet", async () => {
    const run = vi.fn().mockResolvedValue({ meta: { changes: 0 } });
    const bind = vi.fn(() => ({ run }));
    const prepare = vi.fn(() => ({ bind }));
    const repository = new D1PasswordProofRepository({ prepare } as never);

    await expect(repository.saveIfMissing("u1", "c2FsdA", {
      ciphertext: "ciphertext",
      iv: "iv",
      version: 1,
    }, new Date("2026-08-01T00:00:00.000Z"))).resolves.toBe(false);

    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("ON CONFLICT(user_id) DO NOTHING"));
    expect(prepare).toHaveBeenCalledWith(expect.not.stringContaining("DO UPDATE"));
  });
});
