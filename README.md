# Installation Guide

## NPM - YARN

## Option 1 - tracking code

---

Add the following to your `index.html`:

```html
<script>
  const script = document.createElement('script');
  const apiKey = 'YOUR_API_KEY';
  // Add any configuration parameters you'd like here
  const config = {};
  script.src = 'https://unpkg.com/@formo/analytics';
  script.onload = function () {
    FormoAnalytics.init(apiKey).then((sdkInstance) => setSdk(sdkInstance));
  };
  document.head.appendChild(script);
</script>
```

## Option 2 - using npm package

---

1. Install the npm package:

```
yarn add @formo/analytics
```

or

```
npm install @formo/analytics --save
```

2. Initialize the SDK and keep an instance of it ready to reference in other parts of your app. To do this, add the following code on your app’s load:

```jsx
import { FormoAnalytics } from '@formo/analytics';

const sdk = await FormoAnalytics.init(API_KEY);
```

# Development notes

To run a local version of the script:

1. Run `yarn build-cjs && yarn build-esm && yarn webpack --mode=production` or `npm run build` at the root level to build the script.
2. Run `yarn publish` or `npm run publish` to publish new versions of the package.
