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

1. **Preview release notes**:
   ```bash
   pnpm preview-release
   ```
   This shows what the release notes will look like based on commits since the last tag.


2. **Update the version** using npm:
   ```bash
   npm version patch  # For bug fixes
   npm version minor  # For new features
   npm version major  # For breaking changes
   ```
   
   This automatically:
   - Updates `package.json` with the new version
   - Updates `src/version.ts` with the new version (via the `version` script hook)
   - Creates a git commit with both changes
   - Creates a version tag (e.g., `v1.24.1`)

3. **Push the commit and tag**:
   ```bash
   git push --follow-tags
   ```

4. **Automatic workflow execution**:
   - GitHub Actions workflow triggers on the `v*` tag
   - Builds and tests the package
   - Publishes to npm using OIDC (no tokens needed!)
   - Creates a GitHub release with:
     - Changelog from git commits
     - Installation instructions
     - CDN usage examples
     - SRI hash for secure CDN usage
