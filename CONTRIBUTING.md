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

> See [this guide](https://dev.to/one-beyond/different-approaches-to-testing-your-own-packages-locally-npm-link-4hoj) on how to use `npm link`  or [this guide](https://classic.yarnpkg.com/lang/en/docs/cli/link/) for `yarn link` to test the package locally.

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

# Publishing

1. Authenticate with NPM

To publish a new version of the package, log in to your NPM account:

```jsx
npm login
```

or:

```jsx
npm adduser
```

2. Publish the Package

Run the following command to publish the package to NPM:

```jsx
npm version prerelease --preid alpha 
OR
npm version

npm run publish
```