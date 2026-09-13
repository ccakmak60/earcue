import { describe, expect, it } from "vitest";
import { errorMessage } from "@/lib/shared/auth-errors";

describe("errorMessage", () => {
  it("maps known better-auth codes to the legacy strings", () => {
    expect(errorMessage("INVALID_EMAIL_OR_PASSWORD")).toBe("Wrong email or password.");
    expect(errorMessage("USER_ALREADY_EXISTS")).toBe("That email already has an account. Sign in instead.");
    expect(errorMessage("USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL")).toBe("That email already has an account. Sign in instead.");
    expect(errorMessage("PASSWORD_TOO_SHORT")).toBe("Use at least 8 characters.");
    expect(errorMessage("EMAIL_PASSWORD_SIGN_UP_DISABLED")).toBe("Account creation is disabled.");
  });

  it("falls back to the generic message", () => {
    expect(errorMessage("SOMETHING_ELSE")).toBe("Something went wrong. Try again.");
    expect(errorMessage()).toBe("Something went wrong. Try again.");
  });
});
