import { defineConfig } from 'vitest/config';

/**
 * Vitest config for the n8n custom-node package.
 *
 * Tests live under `tests/` and exercise pure helpers extracted from
 * the node implementations (verdict routing, HMAC verification,
 * credential normalization).
 *
 * Test files use `.mts`. `n8n-node lint` runs the n8n Cloud rules over every
 * `.ts` file in the package, and those rules are written for node code: they
 * forbid the imports a test runner needs (vitest, node:*). Tests are not part
 * of the published package (`files` in package.json ships `dist` only), so
 * they are kept out of that lint rather than weakening the lint config. Anything that requires the full n8n
 * runtime — execute(), webhook() — is intentionally out of scope; the
 * upstream `n8n-workflow` package does not ship a test harness for
 * those entry points and mocking it produces brittle tests with low
 * signal.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.mts'],
    environment: 'node',
    // Limit globs so vitest doesn't accidentally pick up the demo
    // workflow JSON or the seed scripts when invoked from the parent
    // monorepo.
    exclude: ['node_modules/**', 'dist/**'],
    // Tests are fast and synchronous; running serially makes failure
    // output predictable in CI logs.
    pool: 'forks',
    maxWorkers: 1,
  },
});
