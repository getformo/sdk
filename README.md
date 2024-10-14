# Installation Guide

## NPM - YARN

---

---

1. Install the npm package:

```
yarn add @formo/analytics-sdk
```

or

```
npm install @formo/analytics-sdk --save
```

2. Initialize the SDK and keep an instance of it ready to reference in other parts of your app. To do this, add the following code on your app’s load:

```jsx
import { FormoAnalyticsSdk } from '@formo/analytics-sdk'

const sdk = await FormoAnalyticsSdk.init(API_KEY, {
    //TODO: Add more details
})
```

# Development notes

To run a local version of the script:

1. Run `yarn build` at the root level to build the script.
2. Run `yarn publish` or `npm run publish` to publish new versions of the package.