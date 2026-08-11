import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/plugin.ts",
    cli: "src/cli.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: false,
  target: "es2022",
  outDir: "dist",
});
