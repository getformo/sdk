# Installation Guide

## NPM - YARN

## Option 1 - tracking code

---

Add the following to your `index.html`:

```html
<script
  defer
  src="https://unpkg.com/@formo/sdk@1.1.7/dist/index.js"
  data-token="YOUR_API_KEY_HERE"
></script>
```

## Option 2 - using npm package

---

1. Install the npm package:

```
yarn add @formo/sdk
```

or

```
npm install @formo/sdk --save
```

2. Initialize the SDK and keep an instance of it ready to reference in other parts of your app. To do this, add the following code on your app’s load:

```jsx
import { FormoAnalyticsSdk } from '@formo/sdk';

const sdk = await FormoAnalyticsSdk.init(API_KEY, {
  //TODO: Add more details
});
```

# Development notes

To run a local version of the script:

1. Run `yarn build` at the root level to build the script.
2. Run `yarn publish` or `npm run publish` to publish new versions of the package.
