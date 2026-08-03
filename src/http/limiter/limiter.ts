export abstract class Limiter {

    public abstract tryAcquire(now: number): boolean;
    public abstract timeUntilToken(now: number): number;
}
