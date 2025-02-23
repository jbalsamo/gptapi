/**
 * A token bucket rate limiter implementation
 */
export class RateLimiter {
  constructor(tokensPerInterval, intervalInMs) {
    this.tokensPerInterval = tokensPerInterval;
    this.intervalInMs = intervalInMs;
    this.tokens = tokensPerInterval;
    this.lastRefill = Date.now();
  }

  async waitForToken() {
    this.refillTokens();

    if (this.tokens < 1) {
      const waitTime = this.intervalInMs / this.tokensPerInterval;
      await new Promise((resolve) => setTimeout(resolve, waitTime));
      this.refillTokens();
    }

    this.tokens -= 1;
    return true;
  }

  refillTokens() {
    const now = Date.now();
    const timePassed = now - this.lastRefill;
    const tokensToAdd =
      Math.floor(timePassed / this.intervalInMs) * this.tokensPerInterval;

    if (tokensToAdd > 0) {
      this.tokens = Math.min(this.tokensPerInterval, this.tokens + tokensToAdd);
      this.lastRefill = now;
    }
  }
}

// Create default rate limiters for different API endpoints
export const rateLimiters = {
  chatCompletions: new RateLimiter(80000, 60000), // 80000 requests per minute
  search: new RateLimiter(100, 60000), // 100 requests per minute
};
