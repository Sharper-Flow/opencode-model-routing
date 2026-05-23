// plugin.ts — OpenCode V1 plugin module runtime entry point.
//
// Keep this file's runtime export surface intentionally narrow. OpenCode's
// legacy loader treats every function-valued module export as a plugin, so the
// bundled package entry must export only the V1 default object.

import type { Plugin, PluginModule } from "@opencode-ai/plugin";
import { createPluginHooks, type PluginInput } from "./plugin-internal.ts";

const server = (async (input: unknown, _options?: unknown) => {
  await Promise.resolve();
  return createPluginHooks(input as PluginInput);
}) as Plugin;

// eslint-disable-next-line import/no-default-export
export default {
  id: "@sharper-flow/opencode-model-routing-plugin",
  server,
} satisfies PluginModule;
