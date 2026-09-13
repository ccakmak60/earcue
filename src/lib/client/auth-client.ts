import "client-only";
import { createAuthClient } from "better-auth/react";

// Same-origin client for /api/auth/*.
export const authClient = createAuthClient();
