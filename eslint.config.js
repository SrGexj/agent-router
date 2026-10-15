import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";

const noEnv = {
  "no-restricted-properties": ["error",
    { object: "process", property: "env", message: "Lee la configuración en src/config.mjs." },
    { object: "import.meta", property: "env", message: "Lee la configuración en src/config.mjs." }
  ]
};

export default [
  { ignores: ["**/node_modules/**", "dashboard/dist/**", "coverage/**"] },
  js.configs.recommended,
  {
    files: ["**/*.{js,mjs,jsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } }
    },
    rules: { ...noEnv, "no-unused-vars": ["error", { argsIgnorePattern: "^_" }] }
  },
  {
    files: ["dashboard/src/**/*.{js,jsx}"],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // JSX: marca como usadas las variables que solo aparecen en etiquetas.
      "no-unused-vars": ["error", { varsIgnorePattern: "^[A-Z]", argsIgnorePattern: "^_" }]
    }
  },
  // Los tests y pruebas lanzan procesos hijos y les pasan el entorno.
  { files: ["src/config.mjs", "pruebas/**", "test/**"], rules: { "no-restricted-properties": "off" } },
  // Los scripts E2E evalúan funciones dentro de la página.
  { files: ["pruebas/**"], languageOptions: { globals: { ...globals.browser } } }
];
