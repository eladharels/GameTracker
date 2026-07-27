// Backend lint. ONE rule earns its keep here above all others: `no-undef`.
//
// A refactor deleted `const CRACKWATCH_CACHE_FILE` and every reference to it sat
// inside a try/catch, so the DRM cache silently stopped working for a whole deploy
// cycle and nothing failed. A runtime guard cannot catch that class reliably — it
// only fires on paths that execute, only in catches someone remembered to annotate,
// and it cannot tell a bug from bad data. `no-undef` finds all four references
// statically, before merge.
//
// devDependencies never enter the image (`npm ci --omit=dev`), so this changes
// neither the Trivy scan surface nor the image size.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['frontend/**', 'node_modules/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      // The control-character class is deliberate in both places it appears: the log
      // and directory-text sanitisers exist precisely to strip those bytes.
      'no-control-regex': 'off',
      // Not a style gate. Unused variables are noise here, not defects, and this
      // config's job is to catch the class of bug that shipped.
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];
