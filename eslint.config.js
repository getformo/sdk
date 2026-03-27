const tseslint = require("typescript-eslint");

module.exports = tseslint.config(
  {
    ignores: ["dist/", "node_modules/"],
  },
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: "module",
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-inferrable-types": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-unused-expressions": "off",
      "@typescript-eslint/no-unsafe-function-type": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-array-constructor": "off",
      "no-empty": "off",
      "prefer-rest-params": "off",
    },
  }
);
