# Development Guide

If you want to contribute or run a local version of the Formo Analytics SDK, follow these steps:

### Build the SDK Locally

Run the following command to build both CommonJS and ESM versions of the SDK:

```bash
pnpm build
```

### Testing locally

1. Link the local package to your project

> See [pnpm link documentation](https://pnpm.io/cli/link) for more details on linking packages locally.

For example, if I want to test the package with a project that is in the same directory:

```
~/
├── formo-analytics-example-next/
└── sdk/
```

Run the following command:

```bash
# In ~/sdk (the package you want to link)
pnpm link --global

# In ~/formo-analytics-example-next (your test project)
pnpm link --global @formo/analytics
```

Any changes you make to your local package will be reflected in the project you linked it to.
However, you have to run `build` to apply the changes you made to the local package:

```bash
# In ~/sdk
pnpm build
```

The new change will be reflected in the project you linked it to.

To unlink the package, run the following command:

```bash
# In ~/formo-analytics-example-next
pnpm unlink --global @formo/analytics

# In ~/sdk (optional: remove the global link)
pnpm unlink --global
```

## Troubleshooting

- Remove your `node_modules` and re-link: `pnpm unlink --global && pnpm link --global && pnpm install`
- Try running `pnpm build` in the SDK directory to ensure the changes are applied.
- Try unlinking and relinking again.

# Making Changes and Releases

This project uses [Changesets](https://github.com/changesets/changesets) for version management and releases.

## Adding a Changeset

When you make a change that should be included in the release notes, you need to add a changeset:

```bash
pnpm changeset
```

This will prompt you to:
1. Select the type of change (major, minor, or patch)
2. Write a summary of your changes

The command will create a new file in the `.changeset` directory. Commit this file along with your changes.

### When to Add a Changeset

- ✅ **New features** - Add a changeset with a `minor` bump
- ✅ **Bug fixes** - Add a changeset with a `patch` bump
- ✅ **Breaking changes** - Add a changeset with a `major` bump
- ✅ **User-facing changes** - Any change that affects users
- ❌ **Documentation** - Usually doesn't need a changeset
- ❌ **Tests** - Usually doesn't need a changeset
- ❌ **Internal refactoring** - Usually doesn't need a changeset (unless it affects the API)

### Release Types

| Change Type | Version Bump | Example |
| ----------- | ------------ | ------- |
| Breaking change | Major (1.0.0 → 2.0.0) | Removing or changing existing APIs |
| New feature | Minor (1.0.0 → 1.1.0) | Adding new functionality |
| Bug fix | Patch (1.0.0 → 1.0.1) | Fixing existing functionality |

## Release Process

Releases are automated via GitHub Actions:
1. When changes with changesets are merged to `main`, a "Version Packages" PR is automatically created
2. This PR updates the version in `package.json` and `CHANGELOG.md`
3. When the "Version Packages" PR is merged, the package is automatically published to npm with provenance
