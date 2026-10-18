import js from "@eslint/js";
import tseslint from "typescript-eslint";

const sdkPatterns = ["@modelcontextprotocol/sdk", "@modelcontextprotocol/sdk/*"];
const googlePatterns = [
  "googleapis",
  "@googleapis/*",
  "google-auth-library",
  "google-auth-library/*",
];

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**"] },
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
  {
    files: ["src/**/*.ts"],
    rules: { "no-console": "error" },
  },
  {
    // Only server.ts / index.ts may touch the MCP SDK.
    files: ["src/**/*.ts"],
    ignores: ["src/server.ts", "src/index.ts"],
    rules: { "no-restricted-imports": ["error", { patterns: sdkPatterns }] },
  },
  {
    // Only google/* and auth/* may touch Google client libraries (cli/auth.ts uses the auth module).
    files: ["src/**/*.ts"],
    ignores: ["src/google/**", "src/auth/**"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [...sdkPatterns, ...googlePatterns] }],
    },
  },
  {
    files: ["src/server.ts", "src/index.ts"],
    rules: { "no-restricted-imports": ["error", { patterns: googlePatterns }] },
  },
  {
    // Tools never reach the network.
    files: ["src/tools/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [...sdkPatterns, ...googlePatterns],
          paths: ["node:http", "node:https", "node:net", "node:child_process", "http", "https"],
        },
      ],
      "no-restricted-globals": ["error", "fetch"],
    },
  },
  { files: ["src/cli/**/*.ts"], rules: { "no-console": "off" } },
);
