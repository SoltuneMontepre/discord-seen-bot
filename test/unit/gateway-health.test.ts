import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayHealth, type WatermarkStore } from "../../src/app/gateway-health.ts";
import { dateClock, memoryLogger } from "../helpers/app.ts";
import { MIN, T0 } from "../helpers/domain.ts";

function store(initial: number | null = null) {
  const s: WatermarkStore & { value: number | null; writes: number[] } = {
    value: initial,
    writes: [],
    async getWatermark() {
      return s.value;
    },
    async setWatermark(at: number) {
      s.value = at;
      s.writes.push(at);
    },
  };
  return s;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

/** "message-evidence watermark" — never claims anything about typing. */
describe("GatewayHealth (message-evidence watermark)", () => {
  function healthy(s = store()) {
    const h = new GatewayHealth(dateClock, s, 120_000, memoryLogger());
    h.onReady();
    h.gapRecoveryCompleted();
    return { h, s };
  }

  it("(a) healthy process: every tick advances the watermark to the tick time", async () => {
    const { h, s } = healthy();
    for (let i = 1; i <= 3; i++) {
      vi.setSystemTime(T0 + i * MIN);
      h.onHeartbeatAck(Date.now());
      expect(await h.tick()).toBe(true);
    }
    expect(s.writes).toEqual([T0 + MIN, T0 + 2 * MIN, T0 + 3 * MIN]);
  });

  it("(b) gateway disconnected while the process stays alive: no advance for 20 minutes", async () => {
    const { h, s } = healthy();
    vi.setSystemTime(T0 + MIN);
    await h.tick();
    h.onClosed(1006);
    for (let i = 2; i <= 21; i++) {
      vi.setSystemTime(T0 + i * MIN);
      expect(await h.tick()).toBe(false);
    }
    expect(s.value).toBe(T0 + MIN);
  });

  it("stale heartbeat acks block advancing even while 'up' (zombie connection)", async () => {
    const { h, s } = healthy();
    vi.setSystemTime(T0 + 2 * MIN + 1);
    expect(await h.tick()).toBe(false);
    expect(s.writes).toEqual([]);
  });

  it("fresh READY blocks advancing until gap recovery completes", async () => {
    const s = store(T0 - MIN);
    const h = new GatewayHealth(dateClock, s, 120_000, memoryLogger());
    h.onReady();
    expect(await h.tick()).toBe(false);
    h.gapRecoveryCompleted();
    expect(await h.tick()).toBe(true);
  });

  it("READY transition happens before W is read; a concurrent tick cannot change W", async () => {
    const s = store(T0 - 10 * MIN);
    const h = new GatewayHealth(dateClock, s, 120_000, memoryLogger());
    h.onReady();
    const [W, advanced] = await Promise.all([h.readWatermark(), h.tick()]);
    expect(W).toBe(T0 - 10 * MIN);
    expect(advanced).toBe(false);
  });

  it("(d) RESUMED marks healthy without requesting recovery and keeps a pending recovery pending", async () => {
    const { h } = healthy();
    h.onClosed(1006);
    h.onResumed();
    expect(h.connection).toBe("up");
    expect(await h.tick()).toBe(true);

    h.onReady(); // new fresh session with pending recovery
    h.onClosed(1006);
    h.onResumed();
    expect(h.gapRecoveryPending).toBe(true);
    expect(await h.tick()).toBe(false);
  });

  it("markGapRecoveryNeeded (message write failure) freezes the watermark", async () => {
    const { h } = healthy();
    h.markGapRecoveryNeeded();
    expect(await h.tick()).toBe(false);
  });

  it("crash while healthy leaves a watermark no older than one tick", async () => {
    const { h, s } = healthy();
    vi.setSystemTime(T0 + 5 * MIN);
    h.onHeartbeatAck(Date.now());
    await h.tick();
    // crash at T0 + 5m + 59s: nothing else is written
    expect(T0 + 5 * MIN + 59_000 - (s.value ?? 0)).toBeLessThan(60_000);
  });
});
