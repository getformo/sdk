# How to contribute

If you want to contribute or run a local version of the Formo Analytics SDK, follow these steps:

## Build the SDK Locally

Run the following command to build both CommonJS and ESM versions of the SDK:

```bash
pnpm install
pnpm build
pnpm test
```

## Testing Locally

### Link the Local Package

To test your SDK changes in a a test app, you can link the package locally using `npm link` or `pnpm link`.

For example, if your projects are in the same directory:

```
~/
├── formo-analytics-example-next/
└── sdk/
```

Run the following commands:

```bash
# In ~/formo-analytics-example-next
pnpm link ../sdk
```

Or with npm:

```bash
# In ~/formo-analytics-example-next
npm link ../sdk
```

### Apply Changes

Any changes you make to your local package require rebuilding to be reflected:

```bash
# In ~/sdk
pnpm build
```

The changes will automatically be available in the linked project.

### Unlink the Package

To remove the link:

```bash
# In ~/formo-analytics-example-next
pnpm unlink ../sdk
```

Or with npm:

```bash
# In ~/formo-analytics-example-next
npm unlink ../sdk
```

## Running Tests

Run the test suite:

```bash
pnpm test
```

## Linting

Check code style:

```bash
pnpm lint
```
## Publishing

`main` is protected, so a release goes through a pull request and a tag.

1. **Preview the release notes**:
   ```bash
   pnpm preview-release
   ```
   This shows the notes generated from the commits since the last tag.

2. **Open a release PR** from an up-to-date `main`:
   ```bash
   git switch -c release/X.Y.Z origin/main
   npm version X.Y.Z --no-git-tag-version
   node scripts/update-version.js   # the npm hook does not run with --no-git-tag-version
   git commit -am "chore(release): X.Y.Z"
   ```
   Use a patch version for fixes, minor for features, and major for breaking changes. The `version-sync` check fails if `package.json` and `src/version.ts` differ.

3. **Merge the PR, then tag the merged commit on `main`**:
   ```bash
   git fetch origin main
   git tag vX.Y.Z origin/main
   git push origin vX.Y.Z
   ```

4. **The release workflow runs on the tag** (`.github/workflows/release.yml`):
   - The build job checks that the tag is on `main` and matches `package.json`, then builds, tests, packs, and rejects secret files in the package.
   - The publish job publishes that exact tarball to npm with OIDC provenance (no tokens).
   - The release job creates the GitHub release with the changelog and the CDN snippet with its SRI hash. The hash comes from the published tarball.
   - Until step 5 is done, the release job shows a warning that cdn.formo.so does not serve the version yet. This is expected.

5. **Pin the version on cdn.formo.so** (in `getformo/formono`). The CDN serves only versions in `apps/cdn/src/pinned.json`, and `@latest` serves the newest pinned version.
   ```bash
   pnpm --filter @formo/cdn pin X.Y.Z        # hash comes from the npm tarball
   # open a PR, merge it, then from an up-to-date main:
   pnpm --filter @formo/cdn run deploy       # runs verify after the deploy
   ```
   Do not skip this step: until it is done, `cdn.formo.so/analytics@X.Y.Z` returns 404, and `@latest` stays on the previous version.

6. **Update the places that pin a version**, after the CDN deploy:
   - Dashboard snippet: `FORMO_SDK_CDN_VERSION` and `FORMO_SDK_CDN_INTEGRITY` in `apps/frontend/src/constants/projects/setup-scripts.ts` (getformo/formono), plus the frontend `@formo/analytics` dependency. A new version needs a `minimumReleaseAgeExclude` entry in `pnpm-workspace.yaml` for its first seven days.
   - Docs: the snippets in `install.mdx`, `sdks/web.mdx`, `security/sri.mdx`, and `security/csp.mdx` (getformo/docs.formo.so).
   - formo.so: the SDK tag in Framer (Site Settings > Code > the site-wide "Start of `<head>`" snippet).
   - Examples: the `@formo/analytics` version in each `with-*` example (getformo/examples). Run `gh workflow run sdk-e2e.yml --repo getformo/examples -f sdk_version=X.Y.Z` to test the published version across the examples.
