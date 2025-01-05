# Development Guide

If you want to contribute or run a local version of the Formo Analytics SDK, follow these steps:

1. Build the SDK Locally

Run the following command to build both CommonJS and ESM versions of the SDK:

```jsx
yarn build-cjs && yarn build-esm && yarn webpack --mode=production
```

or if you're using NPM:

```jsx
npm run build
```

2. Authenticate with NPM

To publish a new version of the package, log in to your NPM account:

```jsx
npm login
```

or:

```jsx
npm adduser
```

3. Publish the Package

Run the following command to publish the package to NPM:

```jsx
npm version prerelease --preid alpha 
OR
npm version

npm run publish
```