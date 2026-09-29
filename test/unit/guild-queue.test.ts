import { describe, expect, it } from "vitest";
import { GuildQueue, NestedGuildQueueError } from "../../src/app/guild-queue.ts";

function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => {
    open = r;
  });
  return { p, open };
}
const tick = () => new Promise((r) => setImmediate(r));

describe("GuildQueue", () => {
  it("tasks for one guild run in order", async () => {
    const q = new GuildQueue();
    const log: number[] = [];
    const g = gate();
    const a = q.run("1", async () => {
      await g.p;
      log.push(1);
    });
    const b = q.run("1", async () => {
      log.push(2);
    });
    await tick();
    expect(log).toEqual([]);
    g.open();
    await Promise.all([a, b]);
    expect(log).toEqual([1, 2]);
  });

  it("different guilds run concurrently", async () => {
    const q = new GuildQueue();
    const g = gate();
    const log: string[] = [];
    const a = q.run("1", async () => {
      await g.p;
      log.push("a");
    });
    await q.run("2", async () => {
      log.push("b");
    });
    expect(log).toEqual(["b"]);
    g.open();
    await a;
  });

  it("returns the task's value and propagates its error; a throwing task does not block", async () => {
    const q = new GuildQueue();
    await expect(q.run("1", async () => 42)).resolves.toBe(42);
    await expect(
      q.run("1", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(q.run("1", async () => "next")).resolves.toBe("next");
  });

  it("runKeyed merges a duplicate request while the first is still pending", async () => {
    const q = new GuildQueue();
    const g = gate();
    const blocker = q.run("1", () => g.p);
    let runs = 0;
    const task = async () => {
      runs++;
    };
    const a = q.runKeyed("1", "k", task);
    const b = q.runKeyed("1", "k", task);
    expect(b).toBe(a);
    g.open();
    await Promise.all([blocker, a, b]);
    expect(runs).toBe(1);
  });

  it("runKeyed lossless: a key dirtied while running gets exactly one trailing rerun", async () => {
    const q = new GuildQueue();
    let state = "A";
    const results: string[] = [];
    const g = gate();
    let first = true;
    const task = async () => {
      const seen = state;
      if (first) {
        first = false;
        await g.p;
      }
      results.push(seen);
    };
    const p1 = q.runKeyed("1", "k", task);
    await tick(); // task started, read A, gated
    state = "B";
    const p2 = q.runKeyed("1", "k", task);
    expect(p2).not.toBe(p1);
    g.open();
    await Promise.all([p1, p2]);
    expect(results).toEqual(["A", "B"]);
  });

  it("runKeyed dirtied three times while running → still exactly one trailing rerun", async () => {
    const q = new GuildQueue();
    const g = gate();
    let runs = 0;
    let first = true;
    const task = async () => {
      runs++;
      if (first) {
        first = false;
        await g.p;
      }
    };
    const p1 = q.runKeyed("1", "k", task);
    await tick();
    const rest = [
      q.runKeyed("1", "k", task),
      q.runKeyed("1", "k", task),
      q.runKeyed("1", "k", task),
    ];
    g.open();
    await Promise.all([p1, ...rest]);
    expect(runs).toBe(2);
  });

  it("different keys are not merged", async () => {
    const q = new GuildQueue();
    let runs = 0;
    const task = async () => {
      runs++;
    };
    await Promise.all([q.runKeyed("1", "a", task), q.runKeyed("1", "b", task)]);
    expect(runs).toBe(2);
  });

  it("nested same-guild run throws NestedGuildQueueError instead of hanging", {
    timeout: 1000,
  }, async () => {
    const q = new GuildQueue();
    await expect(q.run("1", () => q.run("1", async () => 1))).rejects.toBeInstanceOf(
      NestedGuildQueueError,
    );
    await expect(q.run("1", () => q.runKeyed("1", "k", async () => {}))).rejects.toBeInstanceOf(
      NestedGuildQueueError,
    );
    await expect(q.run("1", async () => "ok")).resolves.toBe("ok");
  });

  it("nested run for a DIFFERENT guild is allowed", async () => {
    const q = new GuildQueue();
    await expect(q.run("1", () => q.run("2", async () => "inner"))).resolves.toBe("inner");
  });

  it("a cross-guild cycle (1 → 2 → 1) is rejected instead of deadlocking", {
    timeout: 1000,
  }, async () => {
    const q = new GuildQueue();
    await expect(
      q.run("1", () => q.run("2", () => q.run("1", async () => 1))),
    ).rejects.toBeInstanceOf(NestedGuildQueueError);
  });

  it("assertInQueue throws outside a task and passes inside", async () => {
    const q = new GuildQueue();
    expect(() => q.assertInQueue("1")).toThrow(/not inside/);
    await q.run("1", async () => {
      expect(() => q.assertInQueue("1")).not.toThrow();
      expect(() => q.assertInQueue("2")).toThrow(/not inside/);
    });
  });

  it("timers scheduled from inside a task may enqueue for the same guild after it ends", async () => {
    const q = new GuildQueue();
    let later!: Promise<string>;
    const scheduled = new Promise<void>((resolve) => {
      void q.run("1", async () => {
        setTimeout(() => {
          later = q.run("1", async () => "rescheduled");
          resolve();
        }, 5);
      });
    });
    await scheduled;
    await expect(later).resolves.toBe("rescheduled");
  });
});
