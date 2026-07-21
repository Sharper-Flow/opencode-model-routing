// ESLint flat config — see ~/toolbox/docs/dev-tooling-baseline.md § D6
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  // Test files: allow `any` for mocks; relax unused-vars for test-only imports
  {
    files: ["test/**/*.ts", "test/**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  prettierConfig,
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"],
  },
);
