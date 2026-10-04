import { describe, expect, it } from "vitest";
import { cleanWorktrees, rebuildImage } from "../src/maintenance.js";
import { runRound } from "../src/runRound.js";
import { fakeDeps, testConfig } from "./support/fakes.js";

const now = new Date("2026-10-04T15:00:00Z");
const worktree = (n: number, modifiedAt: string) => ({ name: `agent-${n}`, path: `/bot/widgets/.sandcastle/worktrees/agent-${n}`, modifiedAt: new Date(modifiedAt) });

function withWorktrees() {
  const deps = fakeDeps({ issues: [], results: {}, now });
  deps.git.worktrees = [worktree(1, "2026-09-30T15:00:00Z"), worktree(2, "2026-10-04T09:00:00Z")];
  return deps;
}

describe("agent-runner clean-worktrees", () => {
  it("removes only worktrees older than 3 days, like every round does", async () => {
    const deps = withWorktrees();

    await cleanWorktrees(deps, { all: false });

    expect(deps.git.worktrees.map((w) => w.name)).toEqual(["agent-2"]);
  });

  it("removes every worktree with --all", async () => {
    const deps = withWorktrees();

    await cleanWorktrees(deps, { all: true });

    expect(deps.git.worktrees).toEqual([]);
  });
});

describe("agent-runner rebuild", () => {
  it("rebuilds the very image a round would use, without the build cache, so the Claude CLI is fresh", async () => {
    const first = fakeDeps({ issues: [], results: {}, now });
    await runRound(testConfig, first);
    const roundTag = first.sandbox.builtImages[0]!.tag;
    const deps = fakeDeps({ issues: [], results: {}, now, images: [roundTag] });

    await rebuildImage(testConfig, deps);

    expect(deps.sandbox.builtImages).toEqual([{ tag: roundTag, nodeVersion: "22.16.0", fresh: true }]);
  });
});
