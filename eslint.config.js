import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

export default tseslint.config(
  { ignores: ["dist", "coverage", "node_modules"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["src/**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // set-state-in-effect and immutability are too strict for the existing
      // patterns (cache resets in useEffect on space change). Warn only.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/immutability": "warn",
      // ServerSettings exports both a component and helper functions — intentional.
      "react-refresh/only-export-components": "off",
    },
  },
);
