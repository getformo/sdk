# Development Guide

If you want to contribute or run a local version of the Formo Analytics SDK, follow these steps:

### Build the SDK Locally

Run the following command to build both CommonJS and ESM versions of the SDK:

```jsx
yarn build-cjs && yarn build-esm && yarn webpack --mode=production
```

or if you're using NPM:

```jsx
npm run build
```

### Testing locally

1. Link the local package to your project

> See [this guide](https://dev.to/one-beyond/different-approaches-to-testing-your-own-packages-locally-npm-link-4hoj) on how to use `npm link` or [this guide](https://classic.yarnpkg.com/lang/en/docs/cli/link/) for `yarn link` to test the package locally.

For example, if I want to test the package with a project that is in the same directory:

```
~/
├── formo-analytics-example-next/
└── sdk/
```

Run the following command:

```bash
# ~/formo-analytics-example-next
npm link ../sdk
OR
yarn link ../sdk
```

Any changes you make to your local package will be reflected in the project you linked it to.
However, you have to run `build` to apply the changes you made to the local package:

```
# ~/sdk
npm run build
```

The new change will be reflected in the project you linked it to.

To unlink the package, run the following command:

```bash
# In ~/formo-analytics-example-next
npm unlink ../sdk
OR
yarn unlink ../sdk
```

## Troubleshooting

- Remove your `node_modules` and `yarn link` and run `yarn link` and `yarn install` again.
- Try running `yarn build` in the SDK directory to ensure the changes are applied.
- Try running `yarn unlink` and `yarn link` again.

# Commit message format

**semantic-release** uses the commit messages to determine the consumer impact of changes in the codebase.
Following formalized conventions for commit messages, **semantic-release** automatically determines the next [semantic version](https://semver.org) number, generates a changelog and publishes the release.

By default, **semantic-release** uses [Angular Commit Message Conventions](https://github.com/angular/angular/blob/main/contributing-docs/commit-message-guidelines.md).
The commit message format can be changed with the [`preset` or `config` options](docs/usage/configuration.md#options) of the [@semantic-release/commit-analyzer](https://github.com/semantic-release/commit-analyzer#options) and [@semantic-release/release-notes-generator](https://github.com/semantic-release/release-notes-generator#options) plugins.

Tools such as [commitizen](https://github.com/commitizen/cz-cli) or [commitlint](https://github.com/conventional-changelog/commitlint) can be used to help contributors and enforce valid commit messages.

The table below shows which commit message gets you which release type when `semantic-release` runs (using the default configuration):

| Commit message                                                                                                                                                                                   | Release type                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `fix(pencil): stop graphite breaking when too much pressure applied`                                                                                                                             | ~~Patch~~ Fix Release                                                                                           |
| `feat(pencil): add 'graphiteWidth' option`                                                                                                                                                       | ~~Minor~~ Feature Release                                                                                       |
| `perf(pencil): remove graphiteWidth option`<br><br>`BREAKING CHANGE: The graphiteWidth option has been removed.`<br>`The default graphite width of 10mm is always used for performance reasons.` | ~~Major~~ Breaking Release <br /> (Note that the `BREAKING CHANGE: ` token must be in the footer of the commit) |
