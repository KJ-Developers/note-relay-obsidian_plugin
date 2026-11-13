// Obsidian's own developer-guideline rules. The community directory scans every submitted
// version with this rule set and publishes the findings on a public scorecard, so it runs here
// too: a release that fails review is removed from search.
import { defineConfig, globalIgnores } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';

export default defineConfig([
  globalIgnores([
    'node_modules',
    '.test-build',
    'main.js',
    'build.mjs',
    'scripts/check-release-build.mjs',
    'test/build-and-test.mjs',
  ]),
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: { projectService: { allowDefaultProject: ['eslint.config.mjs'] } },
    },
  },
  {
    // The test suite calls node:test's `test()`, which returns a promise. That promise is the
    // runner's own and is awaited by node, not by the test file, so the rule is pure noise here.
    files: ['test/**/*.ts'],
    rules: { '@typescript-eslint/no-floating-promises': 'off' },
  },
]);
