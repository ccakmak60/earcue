// better-auth error codes shown on the sign-in form.
export function errorMessage(code?: string | null): string {
  switch (code) {
    case "INVALID_EMAIL_OR_PASSWORD":
      return "Wrong email or password.";
    case "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL":
    case "USER_ALREADY_EXISTS":
      return "That email already has an account. Sign in instead.";
    case "PASSWORD_TOO_SHORT":
      return "Use at least 8 characters.";
    case "EMAIL_PASSWORD_SIGN_UP_DISABLED":
      return "Account creation is disabled.";
    default:
      return "Something went wrong. Try again.";
  }
}
