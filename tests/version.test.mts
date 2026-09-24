import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { PACKAGE_VERSION } from '../shared/version';

describe('PACKAGE_VERSION', () => {
  it('matches package.json, so Core sees the version that is actually installed', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as { version: string };
    expect(PACKAGE_VERSION).toBe(pkg.version);
  });
});
