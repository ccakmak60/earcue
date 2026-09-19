import "server-only";

// Typed request failures. src/lib/server/respond.ts maps each one to its status and JSON body.

export class Unauthorized extends Error {
  readonly status = 401;
  constructor() {
    super("unauthorized");
  }
}

export class PaymentRequired extends Error {
  readonly status = 402;
  constructor() {
    super("payment_required");
  }
}

export class QuotaExceeded extends Error {
  readonly status = 429;
  readonly metric: string;
  constructor(metric: string) {
    super(`quota:${metric}`);
    this.metric = metric;
  }
}

// The message is the response's `error` string.
export class PayloadTooLarge extends Error {
  readonly status = 413;
}

// The day's Azure OpenAI token ceiling (DAILY_TOKEN_CEILING) is spent. Deliberately 503 and not
// 429: 429 is a per-user quota the client paces against, this is the whole deployment stopping.
export class SpendCeilingReached extends Error {
  readonly status = 503;
}
