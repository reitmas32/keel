import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./passwords";

describe("passwords", () => {
  it("hashes with scrypt and a salt per call, never storing the password", async () => {
    const a = await hashPassword("correct horse battery");
    const b = await hashPassword("correct horse battery");
    expect(a).toMatch(/^scrypt\$16384\$8\$1\$[\w-]{22}\$[\w-]{86}$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain("correct");
    expect(await verifyPassword("correct horse battery", a)).toBe(true);
    expect(await verifyPassword("correct horse batterY", a)).toBe(false);
  });

  it("rejects missing or malformed hashes", async () => {
    expect(await verifyPassword("x", null)).toBe(false);
    expect(await verifyPassword("x", "plain")).toBe(false);
    expect(await verifyPassword("x", "scrypt$0$8$1$AAAA$AAAA")).toBe(false);
    expect(await verifyPassword("x", "bcrypt$1$2$3$a$b")).toBe(false);
  });
});
