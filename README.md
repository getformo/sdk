<p align="center">
	<h1 align="center"><b>Formo Web SDK</b></h1>
<p align="center">
    Unified analytics for onchain apps.
    <br />
    <a href="https://formo.so">Website</a>
    ·
    <a href="https://docs.formo.so">Docs</a>
    ·
    <a href="https://app.formo.so">Dashboard</a>
    ·
    <a href="https://formo.so/slack">Slack</a>
    ·
    <a href="https://twitter.com/getformo">X</a>
  </p>
</p>

## Installation

The Formo Web SDK is a Javascript library that allows you to track and analyze user interactions on your dapp. 

You can install Formo on:
- [Websites](https://docs.formo.so/install#website)
- [React apps](https://docs.formo.so/install#react)
- [Next.js apps](https://docs.formo.so/install#next-js-app-router)

## Configuration

Visit Formo's [Developer Docs](https://docs.formo.so) for detailed guides on local testing, debugging, and consent management.

## Methodology

Learn how Formo handles [onchain attribution](https://docs.formo.so/data/attribution) and [data collection](https://docs.formo.so/data/what-we-collect).

## Support

Join the [Formo community Slack channel](https://formo.so/slack) for help and questions.

## Development

### Building the SDK

```bash
pnpm install
pnpm build
```

### Running Tests

```bash
pnpm test
```

### Publishing a New Release

This project uses **OIDC Trusted Publishing** for secure, automated npm releases. No manual token management required!

#### Prerequisites

1. **Configure Trusted Publisher** (one-time setup):
   - Go to [npmjs.com](https://www.npmjs.com/package/@formo/analytics) package settings
   - Navigate to "Publishing access"
   - Add GitHub Actions as trusted publisher:
     - Repository: `getformo/sdk`
     - Workflow file: `.github/workflows/release.yml`

2. **Recommended Security**: Restrict token-based publishing
   - In package settings → "Publishing access"
   - Select "Require two-factor authentication and disallow tokens"
   - This ensures only the GitHub workflow can publish

#### Release Process

1. **Update the version** in `package.json`:
   ```bash
   npm version patch  # For bug fixes (1.24.0 → 1.24.1)
   npm version minor  # For new features (1.24.0 → 1.25.0)
   npm version major  # For breaking changes (1.24.0 → 2.0.0)
   ```
   
   > **Note**: `npm version` automatically creates a git commit and tag. It updates `package.json`, commits the change, and creates a version tag (e.g., `v1.24.1`).

2. **Push the commit and tag**:
   ```bash
   git push --follow-tags
   # or separately:
   # git push && git push --tags
   ```
   
   > **Important**: You must push both the commit AND the tag. Use `--follow-tags` to push both in one command.

3. **Automatic workflow execution**:
   - GitHub Actions workflow triggers on the `v*` tag
   - Builds and tests the package
   - Publishes to npm using OIDC (no tokens needed!)
   - Creates a GitHub release with:
     - Changelog from git commits
     - Installation instructions
     - CDN usage examples
     - SRI hash for secure CDN usage

#### What Gets Published

- **npm**: `@formo/analytics@<version>`
- **GitHub Release**: Tagged release with changelog and SRI hash
- **CDN**: `https://cdn.formo.so/analytics@<version>`
- **Provenance**: Automatically generated cryptographic attestations

#### Security Features

✅ **OIDC Trusted Publishing** - No long-lived tokens  
✅ **Automatic Provenance** - Cryptographic proof of build authenticity  
✅ **SRI Hash** - Subresource integrity for CDN usage  
✅ **Secure by Default** - Short-lived, workflow-specific credentials

Learn more: [npm Trusted Publishing Documentation](https://docs.npmjs.com/trusted-publishers)

## Contributing

Contributions are welcome! Feel free to open fixes and feature suggestions.

