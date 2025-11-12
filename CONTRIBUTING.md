# Development Guide

If you want to contribute or run a local version of the Formo Analytics SDK, follow these steps:

## Build the SDK Locally

Run the following command to build both CommonJS and ESM versions of the SDK:

```bash
pnpm build
```

or if you're using NPM:

```bash
npm run build
```

The build process will:
1. Clean the `dist` directory
2. Build CommonJS version with TypeScript
3. Build ESM version with TypeScript
4. Bundle UMD version with Webpack
5. Clean up temporary build artifacts

## Testing Locally

### Link the Local Package

To test your changes in another project, you can link the package locally using `npm link` or `pnpm link`.

For example, if your projects are in the same directory:

```
~/
├── formo-analytics-example-next/
└── sdk/
```

Run the following commands:

```bash
# In ~/sdk
pnpm link --global

# In ~/formo-analytics-example-next
pnpm link --global @formo/analytics
```

Or with npm:

```bash
# In ~/sdk
npm link

# In ~/formo-analytics-example-next
npm link @formo/analytics
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
pnpm unlink --global @formo/analytics

# In ~/sdk
pnpm unlink --global
```

Or with npm:

```bash
# In ~/formo-analytics-example-next
npm unlink @formo/analytics

# In ~/sdk
npm unlink
```

## Running Tests

Run the test suite:

```bash
pnpm test
```

For continuous testing during development:

```bash
pnpm test-watch
```

## Linting

Check code style:

```bash
pnpm lint
```

## Troubleshooting

- Remove your `node_modules` and reinstall dependencies:
  ```bash
  rm -rf node_modules pnpm-lock.yaml
  pnpm install
  ```
- Ensure you've built the SDK after making changes: `pnpm build`
- Try unlinking and relinking the package if changes aren't reflected

## Publishing

See the [README](./README.md#development) for detailed publishing instructions.

In summary:

1. **Update the version** using npm:
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

2. **Push the commit and tag**:
   ```bash
   git push --follow-tags
   ```

3. The GitHub Actions workflow will automatically publish to npm using OIDC trusted publishing.

