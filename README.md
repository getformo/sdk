# Installation Guide

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

2. Set up the `FormoAnalyticsProvider` in your application:

```jsx
// FormoAnalyticsProvider.tsx

'use client';

import { FormoAnalytics, FormoAnalyticsProvider } from '@formo/analytics';
import React, { FC, useEffect } from 'react';

type FormoAnalyticsProviderProps = {
  apiKey: string;
  projectId: string;
  children: React.ReactNode;
};

// The provider component
export const AnalyticsProvider: FC<FormoAnalyticsProviderProps> = ({
  apiKey,
  projectId,
  children,
}) => {
  // Initialize the FormoAnalytics SDK inside useEffect
  useEffect(() => {
    const initialize = async () => {
      try {
        await FormoAnalytics.init(apiKey, projectId);
        console.log('FormoAnalytics SDK initialized');
      } catch (error) {
        console.error('Failed to initialize FormoAnalytics SDK', error);
      }
    };

    initialize();
  }, [apiKey]);

  return (
    <FormoAnalyticsProvider apiKey={apiKey} projectId={projectId}>
      {children}
    </FormoAnalyticsProvider>
  );
};

export default AnalyticsProvider;
```

1. Integrating the Provider in Your Layout
Wrap your application with the `AnalyticsProvider` in your main layout file:

```jsx
import { FormoAnalyticsProvider } from './FormoAnalyticsProvider';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
      <html lang="en">
        <body>
          <FormoAnalyticsProvider
            apiKey="YOUR_API_KEY"
            projectId="formo"
          >
            Your Page Content
          </FormoAnalyticsProvider>
        </body>
      </html>
  );
}
```

3. Using the SDK
Once the SDK is initialized, you can use its methods to track events and user interactions. Here’s how to do that:

```jsx
import { useFormoAnalytics } from '@formo/analytics';
import React, { useEffect } from 'react';

const YourComponent = () => {
  const analytics = useFormoAnalytics();

  useEffect(() => {
    const initialize = async () => {
      try {
        console.log('Tracking page hit...');
        analytics.page(); // Track the page view
        analytics.track('custom_event', { key: 'value' }); // Track a custom event
      } catch (error) {
        console.error('Failed to track page hit', error);
      }
    };

    initialize();
  }, [analytics]);

  return <div>Your Component Content</div>;
};
```

# Development notes

To run a local version of the script:

1. Run `yarn build-cjs && yarn build-esm && yarn webpack --mode=production` or `npm run build` at the root level to build the script.
2. To authorize device, login into npmjs using `npm login` or `npm adduser`
3. Run `yarn publish` or `npm run publish` to publish new versions of the package.
