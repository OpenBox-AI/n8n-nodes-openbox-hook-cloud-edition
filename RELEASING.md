# Releasing

`n8n-nodes-openbox-hook` publishes to npm from `main` through GitHub Actions
([`release.yml`](./.github/workflows/release.yml)).

## One-time setup

Publishing uses npm Trusted Publishing (GitHub OIDC), so no long-lived token is
needed:

1. npmjs.com → `n8n-nodes-openbox-hook` → Settings → Trusted Publishers.
2. Add GitHub Actions: owner `OpenBox-AI`, repository `n8n-nodes-openbox-hook-cloud-edition`,
   workflow `release.yml`.

`repository.url` in `package.json` must name this repository. npm checks it
against the provenance statement and refuses the publish if they differ.

Fallback: set an `NPM_TOKEN` repository secret with publish access to the
package.

## Branches

- Feature work branches from `main` as `<type>/<short-description>`
  (e.g. `feat/prod-1020-iam-v3-workload`) and merges back through a PR.
- PR titles start with the Jira key: `[PROD-<n>] <type>(<scope>): <description>`.
  Every commit message carries a `PROD-<n>` key too.

## Release flow

1. In a release PR, bump `version` in [`package.json`](./package.json)
   (`npm version <x.y.z> --no-git-tag-version` updates the lockfile too).
2. Merge it into `main`.
3. The workflow then:
   - checks the version is not already on npm, and stops if it is;
   - runs lint, type-check, build, the node-load smoke test, tests and
     `npm pack --dry-run`;
   - scans dependencies (Trivy) and the tree for secrets (Gitleaks);
   - publishes with `npm publish --provenance --access public`;
   - creates a GitHub release tagged `v<version>`.

Pushes to `main` that do not change `package.json` do not publish.

## After publishing

n8n's scanner must pass on the published package, and it requires provenance:

```bash
npx @n8n/scan-community-package n8n-nodes-openbox-hook@<version>
```

## Manual recovery

The workflow can also be run by hand from the Actions tab (`workflow_dispatch`),
for example when the publish succeeded but the GitHub release was not created.
It checks npm first, so it never republishes an existing version.

## Local check before a release

```bash
npm ci
npm run lint
npx tsc --noEmit -p tsconfig.json
npm run build
npm run smoke:load
npm test
npm pack --dry-run
npx n8n-node cloud-support   # must report ENABLED
```
