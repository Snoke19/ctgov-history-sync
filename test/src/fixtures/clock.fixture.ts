export class FakeMonotonicClock {
    private current = 0;

    now = (): number => this.current;

    advance = (ms: number): void => {
        this.current += ms;
    };
}

export class FakeWallClock {
    private current = 0;

    now = (): number => this.current;

    advance = (ms: number): void => {
        this.current += ms;
    };
}

export class FakeSleeper {
    constructor(private readonly clock: FakeMonotonicClock) {}

    sleep = async (ms: number, _signal?: AbortSignal): Promise<void> => {
        this.clock.advance(ms);
        await Promise.resolve();
    };
}

export function createClockFixture() {
    const monotonicClock = new FakeMonotonicClock();
    const wallClock = new FakeWallClock();
    const sleeper = new FakeSleeper(monotonicClock);

    return {
        monotonicClock,
        wallClock,
        sleep: sleeper.sleep,
        random: () => 0.5,
    };
}

export type ClockFixture = ReturnType<typeof createClockFixture>;
