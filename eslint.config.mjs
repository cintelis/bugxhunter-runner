// ESLint flat config for both workspaces: typescript-eslint's recommended
// rules plus the React hooks rules for the web app.
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "docker/**", "shared/**"] },
  ...tseslint.configs.recommended,
  {
    files: ["server/src/**/*.ts", "web/src/**/*.{ts,tsx}"],
    rules: {
      // The OpenCode SDK and SCX payloads are loosely typed; `any` at those
      // boundaries is deliberate.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
    },
  },
  {
    files: ["web/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
);
