import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'src/generated/**', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['tools/**/*.cjs'], languageOptions: { sourceType: 'commonjs' }, rules: { '@typescript-eslint/no-require-imports': 'off' } },
  { languageOptions: { globals: { ...globals.node, ...globals.browser } } },
);
