import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFlock } from "../src/lock.js";

const lockFile = () => join(mkdtempSync(join(tmpdir(), "agent-runner-lock-")), "round.lock");

describe("flock lock", () => {
  it("refuses a second holder while the first still holds the lock", async () => {
    const path = lockFile();
    const release = await createFlock(path).tryAcquire();

    const second = await createFlock(path).tryAcquire();

    await release?.();
    expect(second).toBeNull();
  });

  it("can be taken again after the holder releases it", async () => {
    const path = lockFile();
    const release = await createFlock(path).tryAcquire();
    await release?.();

    const again = await createFlock(path).tryAcquire();

    await again?.();
    expect(again).not.toBeNull();
  });
});
