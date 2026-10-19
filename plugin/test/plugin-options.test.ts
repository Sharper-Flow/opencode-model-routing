// plugin-options.test.ts — the README-documented scalar tuning options in the
// plugin tuple option (V1) or native plugin options (V2) reach the runtime
// PluginConfig.
//
// Both production entry points (createPluginHooks, setupV2Plugin) build their
// context through createPluginContext({ pluginOptions }), so the option layer
// is read there: default < programmatic config < plugin options. An invalid
// value is dropped with a warn log and the default stays; nothing throws.

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createLogger, type Logger } from "../src/logging/logger.ts";
import {
  createPluginContext,
  createPluginHooks,
  setupV2Plugin,
  type V2SessionDomain,
} from "../src/plugin-internal.ts";
import { TtftRegistry } from "../src/ttft.ts";
import { defaultConfig } from "../src/types.ts";

interface Captured {
  logger: Logger;
  warnings: Array<Record<string, unknown>>;
}

function capturingLogger(): Captured {
  const warnings: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    minLevel: "warn",
    file: "",
    write: (line) => warnings.push(JSON.parse(line)),
  });
  return { logger, warnings };
}

function configFrom(pluginOptions: unknown, captured = capturingLogger()) {
  return createPluginContext({ pluginOptions, logger: captured.logger }).config;
}

const INVALID_EVENT = "pluginOptions.config.invalid_value";

describe("plugin options reach PluginConfig", () => {
  test("every documented scalar option overrides its default", () => {
    const config = configFrom({
      agents: {},
      ttftMs: 300_000,
      cooldownMs: 120_000,
      maxDepth: 5,
      dedupWindowMs: 1_000,
      abortWaitMs: 400,
      preserveContext: false,
    });
    expect(config.ttftMs).toBe(300_000);
    expect(config.cooldownMs).toBe(120_000);
    expect(config.maxDepth).toBe(5);
    expect(config.dedupWindowMs).toBe(1_000);
    expect(config.abortWaitMs).toBe(400);
    expect(config.preserveContext).toBe(false);
  });

  test("plugin options win over programmatic config, which wins over defaults", () => {
    const ctx = createPluginContext({
      config: { ttftMs: 90_000, maxDepth: 2 },
      pluginOptions: { ttftMs: 300_000 },
      logger: capturingLogger().logger,
    });
    expect(ctx.config.ttftMs).toBe(300_000);
    expect(ctx.config.maxDepth).toBe(2);
    expect(ctx.config.cooldownMs).toBe(defaultConfig.cooldownMs);
  });

  test("zero is a valid value where the option admits it", () => {
    const captured = capturingLogger();
    const config = configFrom(
      { maxDepth: 0, cooldownMs: 0, dedupWindowMs: 0, abortWaitMs: 0 },
      captured,
    );
    expect(config.maxDepth).toBe(0);
    expect(config.cooldownMs).toBe(0);
    expect(config.dedupWindowMs).toBe(0);
    expect(config.abortWaitMs).toBe(0);
    expect(captured.warnings).toHaveLength(0);
  });

  test("cooldownMsByCategory handling is unchanged beside the scalar options", () => {
    const config = configFrom({
      ttftMs: 300_000,
      cooldownMsByCategory: { rate_limit: 60_000 },
    });
    expect(config.ttftMs).toBe(300_000);
    expect(config.cooldownMsByCategory?.rate_limit).toBe(60_000);
    expect(config.cooldownMsByCategory?.quota_exhausted).toBe(
      defaultConfig.cooldownMsByCategory?.quota_exhausted,
    );
  });
});

describe("invalid plugin option values keep the default and warn", () => {
  const invalid: Array<[keyof typeof defaultConfig, unknown]> = [
    ["ttftMs", 0],
    ["ttftMs", -1],
    ["ttftMs", 1.5],
    ["ttftMs", "300000"],
    ["ttftMs", Number.NaN],
    ["ttftMs", Number.POSITIVE_INFINITY],
    ["maxDepth", -1],
    ["maxDepth", 2.5],
    ["maxDepth", "3"],
    ["cooldownMs", -1],
    ["cooldownMs", Number.POSITIVE_INFINITY],
    ["dedupWindowMs", -5],
    ["abortWaitMs", null],
    ["preserveContext", "false"],
    ["preserveContext", 0],
  ];

  for (const [option, value] of invalid) {
    test(`${option} = ${String(value)} is dropped with a warning`, () => {
      const captured = capturingLogger();
      const config = configFrom({ [option]: value }, captured);
      expect(config[option]).toEqual(defaultConfig[option]);
      const warning = captured.warnings.find(
        (w) => w.event === INVALID_EVENT && w.option === option,
      );
      expect(warning).toBeDefined();
    });
  }

  test("an invalid value does not discard valid siblings", () => {
    const config = configFrom({ ttftMs: -1, maxDepth: 4 });
    expect(config.ttftMs).toBe(defaultConfig.ttftMs);
    expect(config.maxDepth).toBe(4);
  });

  for (const options of [undefined, null, "ttftMs", [300_000], 42]) {
    test(`non-object plugin options (${JSON.stringify(options)}) keep every default`, () => {
      const captured = capturingLogger();
      expect(() => configFrom(options, captured)).not.toThrow();
      const config = configFrom(options, captured);
      expect(config.ttftMs).toBe(defaultConfig.ttftMs);
      expect(config.maxDepth).toBe(defaultConfig.maxDepth);
      expect(config.preserveContext).toBe(defaultConfig.preserveContext);
    });
  }
});

describe("production entry points arm TTFT with the configured ttftMs", () => {
  const options = {
    ttftMs: 300_000,
    agents: { build: { fallback_models: ["a/one", "b/two"] } },
  };
  let arm: ReturnType<typeof spyOn<TtftRegistry, "arm">> | undefined;

  afterEach(() => {
    arm?.mockRestore();
    arm = undefined;
  });

  function spyArm(): number[] {
    const armed: number[] = [];
    const original = TtftRegistry.prototype.arm;
    arm = spyOn(TtftRegistry.prototype, "arm").mockImplementation(function (
      this: TtftRegistry,
      sessionId: string,
      ms: number,
      onTimeout: () => void,
    ) {
      armed.push(ms);
      // Record the window without leaving a live timer behind.
      original.call(this, sessionId, ms, onTimeout);
      this.clear(sessionId);
    });
    return armed;
  }

  test("V1 createPluginHooks", async () => {
    const armed = spyArm();
    const client = {
      session: { get: async () => ({}), messages: async () => [] },
    };
    const hooks = await createPluginHooks({ client } as never, options);
    await hooks.config?.({});
    await hooks["chat.message"]?.(
      { sessionID: "v1", agent: "build" },
      { message: { model: { providerID: "a", modelID: "one" } }, parts: [] },
    );
    await hooks["chat.params"]?.(
      {
        sessionID: "v1",
        agent: "build",
        model: { providerID: "a", id: "one" },
      },
      { options: {} },
    );
    expect(armed).toEqual([300_000]);
  });

  test("V2 setupV2Plugin", async () => {
    const armed = spyArm();
    const hooks = new Map<string, (event: unknown) => unknown>();
    const session: V2SessionDomain = {
      get: async (input) => ({ id: input.sessionID }),
      context: async () => [],
      switchModel: async () => {},
      interrupt: async () => {},
      prompt: async () => {},
      hook: async (name, callback) => {
        hooks.set(name, callback);
        return { dispose: async () => {} };
      },
    };
    const cleanup = await setupV2Plugin({ options, session });
    try {
      await hooks.get("context")?.({
        sessionID: "v2",
        agent: "build",
        model: { providerID: "a", id: "one" },
      });
      expect(armed).toEqual([300_000]);
    } finally {
      cleanup?.();
    }
  });
});
