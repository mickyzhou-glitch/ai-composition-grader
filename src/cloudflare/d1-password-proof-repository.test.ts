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
});
