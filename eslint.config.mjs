import tseslint from "typescript-eslint";
export default tseslint.config(
    { files: ["**/*.ts"],
      extends: [...tseslint.configs.recommendedTypeChecked],
      languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } } },
    { ignores: ["main.js","node_modules/**","*.mjs"] }
);
