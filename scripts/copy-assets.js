#!/usr/bin/env node
 
/**
 * Post-build asset copier. Copies icons into the compiled node/credential folders.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const copies = [
  // Node icon (light and dark theme variants)
  {
    src: path.join(ROOT, 'assets', 'logomark.svg'),
    dest: path.join(ROOT, 'dist', 'nodes', 'OpenBoxAgent', 'openbox.svg'),
  },
  {
    src: path.join(ROOT, 'assets', 'logomark.dark.svg'),
    dest: path.join(ROOT, 'dist', 'nodes', 'OpenBoxAgent', 'openbox.dark.svg'),
  },
  // Credential icon (light and dark theme variants)
  {
    src: path.join(ROOT, 'assets', 'logomark.svg'),
    dest: path.join(ROOT, 'dist', 'credentials', 'openbox.svg'),
  },
  {
    src: path.join(ROOT, 'assets', 'logomark.dark.svg'),
    dest: path.join(ROOT, 'dist', 'credentials', 'openbox.dark.svg'),
  },
];

for (const { src, dest } of copies) {
  if (!fs.existsSync(src)) {
    console.error(`[copy-assets] Source not found: ${src}`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`[copy-assets] copied → ${path.relative(ROOT, dest)}`);
}
