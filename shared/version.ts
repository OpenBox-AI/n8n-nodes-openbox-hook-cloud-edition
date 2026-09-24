/**
 * Package version, reported to Core in the SDK identity headers.
 *
 * Kept as a constant rather than read from package.json at runtime; a test
 * (tests/version.test.ts) fails if the two ever disagree.
 */
export const PACKAGE_VERSION = '0.5.0';
