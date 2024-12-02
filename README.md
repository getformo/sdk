# Installation Guide

## Option 1 - tracking code

---

Add the following to your `index.html`:

```html
<script>
  const script = document.createElement('script');
  const apiKey = 'YOUR_API_KEY';
  const projectId = 'YOUR_PROJECT_ID';

  script.src = 'https://unpkg.com/@formo/analytics';
  script.onload = function () {
    FormoAnalytics.init(apiKey, projectId)
      .then((sdkInstance) => {
        window.formo = sdkInstance;

        // Call the public `page` method to track a page hit
        window.formo.page();
      })
      .catch((error) => {
        console.error('Error initializing FormoAnalytics:', error);
      });
  };
  document.head.appendChild(script);
</script>
```

## Option 2 - using npm package

---

### 1. Install the npm package:

Install @formo/analytics via yarn or npm:

```
yarn add @formo/analytics
```

or

```
npm install @formo/analytics --save
```

### 2. Set up the `FormoAnalyticsProvider` in your application:

```jsx
// AnalyticsProvider.tsx

'use client';

import { FormoAnalytics, FormoAnalyticsProvider } from '@formo/analytics';
import React, { FC, useEffect } from 'react';

type FormoAnalyticsProviderProps = {
  apiKey: string,
  projectId: string,
  children: React.ReactNode,
};

// The provider component
export const AnalyticsProvider: FC<FormoAnalyticsProviderProps> = ({
  apiKey,
  projectId,
  children,
}) => {
  // Initialize the FormoAnalytics SDK inside useEffect
  const [isInitialized, setIsInitialized] = useState(false);

  useEffect(() => {
    const initialize = async () => {
      try {
        await FormoAnalytics.init(apiKey, projectId);
        console.log('FormoAnalytics SDK initialized');
        setIsInitialized(true);
      } catch (error) {
        console.error('Failed to initialize FormoAnalytics SDK', error);
      }
    };

    initialize();
  }, [apiKey, projectId]);

  // To prevent app crashes, render a loading state during initialization
  if (!isInitialized) {
    return (
      <FormoAnalyticsProvider apiKey={apiKey} projectId={projectId}>
        Loading Content
      </FormoAnalyticsProvider>
    );
  }

  return (
    <FormoAnalyticsProvider apiKey={apiKey} projectId={projectId}>
      {children}
    </FormoAnalyticsProvider>
  );
};

export default AnalyticsProvider;
```

### 3. Integrating the Provider in Your Root Layout

Wrap your application with the newly created `AnalyticsProvider` in your main layout file:

```jsx
import { AnalyticsProvider } from './AnalyticsProvider';

export default function RootLayout({
  children,
}: {
  children: React.ReactNode,
}) {
  return (
    <html lang='en'>
      <body>
        <AnalyticsProvider apiKey='YOUR_API_KEY' projectId='YOUR_PROJECT_ID'>
          Your Page Content
        </AnalyticsProvider>
      </body>
    </html>
  );
}
```

### 4. Using the SDK

Once the SDK is initialized, you can use its methods to track events and user interactions. Here’s how to do that:

```jsx
import { useFormoAnalytics } from '@formo/analytics';
import React, { useEffect } from 'react';

const YourComponent = () => {
  const analytics = useFormoAnalytics();

  useEffect(() => {
    const track = async () => {
      try {
        console.log('Tracking page hit...');
        analytics.page(); // Track the page view
        analytics.track('custom_event', { key: 'value' }); // Track a custom event
      } catch (error) {
        console.error('Failed to track page hit', error);
      }
    };

    track();
  }, [analytics]);

  return <div>Your Component Content</div>;
};
```

# Development notes

## Setup

```
yarn install

yarn build
```

## Development

To run a local version of the script:

1. Run `yarn build-cjs && yarn build-esm && yarn webpack --mode=production` or `yarn build` at the root level to build the script.
2. To authorize device, login into npmjs using `npm login` or `npm adduser`
3. Run `yarn publish` or `npm run publish` to publish new versions of the package.
