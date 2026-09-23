// plugin.ts — dual OpenCode runtime entry point.
//
// OpenCode 1 (1.18.29+) decodes the default export as { id, server } and
// ignores setup(); OpenCode 2 decodes it as { id, setup } and ignores
// server(). Keep this file's runtime export surface to `default` only: the
// legacy V1 loader treats every function-valued module export as a plugin,
// so the bundled package entry must not export anything else. The V2
// definition is built structurally (no `@opencode/plugin` import) so the
// same bundle loads under V1 where that package is absent.

import type { Plugin } from "@opencode-ai/plugin";
import {
  createPluginHooks,
  createV2PluginDefinition,
  isPluginInput,
  PLUGIN_ID,
  type V2PluginDefinition,
} from "./plugin-internal.ts";

const server = (async (input: unknown, options?: unknown) => {
  if (!isPluginInput(input)) {
    throw new Error(
      "opencode-model-routing plugin: invalid initialization input",
    );
  }
  return createPluginHooks(input, options);
}) as Plugin;

const v2: V2PluginDefinition = createV2PluginDefinition();

interface DualRuntimePluginModule {
  id: string;
  server: Plugin;
  setup: V2PluginDefinition["setup"];
}

export default {
  id: PLUGIN_ID,
  setup: v2.setup,
  server,
} satisfies DualRuntimePluginModule;
