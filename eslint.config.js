"use strict";

// Flat config (ESLint >= 9). Migrated from .eslintrc.json — same rule set.
const js = require("@eslint/js");
const prettier = require("eslint-config-prettier");
const globals = require("globals");

module.exports = [
  js.configs.recommended,
  prettier,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        ...globals.node,
        ...globals.es2022,
        ...globals.jest,
      },
    },
    rules: {
      // caughtErrors:"none" preserves the ESLint 8 default (ESLint 9 changed it to
      // "all"); keeps the idiomatic `catch (e) {}` sites from the existing codebase
      // passing without source churn during the v10 bump.
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "no-console": "error",
      eqeqeq: ["error", "always"],
      "no-var": "error",
      "prefer-const": ["error", { destructuring: "all" }],
      "no-redeclare": "error",
      "no-prototype-builtins": "error",
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Newly added to eslint:recommended in ESLint 9/10. Not enforced under the
      // previous (v8) config; left off so the bump stays behavior-neutral. Enable
      // and clean up in a dedicated follow-up.
      "no-useless-assignment": "off",
      "preserve-caught-error": "off",
    },
  },
  {
    files: ["test/**/*.js"],
    rules: {
      "no-console": "off",
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["test/smoke-onnx.js", "test/fixtures/generate-models.js"],
    rules: {
      "no-console": "off",
      "no-unused-vars": "off",
    },
  },
];
