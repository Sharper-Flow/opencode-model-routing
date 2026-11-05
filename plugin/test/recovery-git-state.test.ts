import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../src/logging/logger.ts";
import { attemptFallback } from "../src/replay/orchestrator.ts";
import { FallbackStore } from "../src/state/store.ts";
import { defaultConfig } from "../src/types.ts";
import { MockClient } from "./helpers/mock-client.ts";

describe("fallback preserves repository effects of the failed turn", () => {
  for (const reason of ["rate_limit", "ttft_timeout"] as const) {
    test(`${reason}: committed and uncommitted work survives recovery`, async () => {
      const directory = mkdtempSync(join(tmpdir(), "omr-recovery-git-"));
      const git = (...args: string[]) =>
        execFileSync("git", args, {
          cwd: directory,
          encoding: "utf8",
          env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
        }).trim();
      try {
        git("init", "--quiet");
        git("config", "user.name", "Recovery Test");
        git("config", "user.email", "recovery@example.invalid");
        const file = join(directory, "work.txt");
        const beforeTurn = "before the failed turn\n";
        writeFileSync(file, beforeTurn);
        git("add", "work.txt");
        git("commit", "--quiet", "-m", "initial");

        writeFileSync(file, "committed during the failed turn\n");
        git("add", "work.txt");
        git("commit", "--quiet", "-m", "turn work");
        const head = git("rev-parse", "HEAD");
        writeFileSync(
          join(directory, "pending.txt"),
          "unique uncommitted work\n",
        );
        const status = git("status", "--porcelain");

        const client = new MockClient({
          messages: [
            {
              info: { id: "user-1", role: "user", agent: "build" },
              parts: [{ type: "text", text: "finish the work" }],
            },
          ],
        });
        // OpenCode's revert restores the pre-turn files, not the real git
        // HEAD or index. Model that boundary while exercising real git state.
        client.session.revert = async () => {
          writeFileSync(file, beforeTurn);
          rmSync(join(directory, "pending.txt"));
        };
        const store = new FallbackStore();
        store.sessions.get("s1").currentModel = "a/one";
        const result = await attemptFallback({
          sessionId: "s1",
          reason,
          chain: ["a/one", "b/two"],
          client,
          store,
          config: defaultConfig,
          logger: createLogger({ write: () => {} }),
          sleepMs: async () => {},
        });

        expect(result.success).toBe(true);
        expect(client.callsTo("session.prompt")).toHaveLength(1);
        expect(git("rev-parse", "HEAD")).toBe(head);
        expect(git("diff", "HEAD", "--", "work.txt")).toBe("");
        expect(git("status", "--porcelain")).toBe(status);
        expect(readFileSync(join(directory, "pending.txt"), "utf8")).toBe(
          "unique uncommitted work\n",
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});
