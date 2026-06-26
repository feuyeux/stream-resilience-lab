export interface PolicyStateOptions {
  circuitBreakerMs?: number;
  cooldownMs?: number;
}

export class PolicyState {
  readonly circuitBreakerMs: number;
  readonly cooldownMs: number;
  readonly activeSessionLocks = new Set<string>();
  readonly providerCircuitBreakers = new Map<string, number>();
  readonly providerCooldowns = new Map<string, number>();

  constructor(options: PolicyStateOptions = {}) {
    this.circuitBreakerMs = options.circuitBreakerMs ?? 60_000;
    this.cooldownMs = options.cooldownMs ?? 60_000;
  }

  isProviderCircuitOpen(key: string, now = Date.now()): boolean {
    const expiresAt = this.providerCircuitBreakers.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt <= now) {
      this.providerCircuitBreakers.delete(key);
      return false;
    }
    return true;
  }

  openProviderCircuit(key: string, now = Date.now()): void {
    this.providerCircuitBreakers.set(key, now + this.circuitBreakerMs);
  }

  isProviderCoolingDown(key: string, now = Date.now()): boolean {
    const expiresAt = this.providerCooldowns.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt <= now) {
      this.providerCooldowns.delete(key);
      return false;
    }
    return true;
  }

  openProviderCooldown(key: string, now = Date.now()): void {
    this.providerCooldowns.set(key, now + this.cooldownMs);
  }

  isSessionLocked(sessionId: string): boolean {
    return this.activeSessionLocks.has(sessionId);
  }

  lockSession(sessionId: string): void {
    this.activeSessionLocks.add(sessionId);
  }

  unlockSession(sessionId: string): void {
    this.activeSessionLocks.delete(sessionId);
  }
}
