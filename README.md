# Installation Guide

## Option 1 - tracking code

---

Add the following to your page:

```html
<script>
  const script = document.createElement('script');
  const apiKey = 'YOUR_API_KEY';

  script.src = 'https://unpkg.com/@formo/analytics';
  script.onload = function () {
    FormoAnalytics.init(apiKey)
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

### React Application

**1. Install the SDK**
Install the Formo Analytics SDK using Yarn or NPM:

```jsx
yarn add @formo/analytics
```

or

```jsx
npm install @formo/analytics --save
```

**2. Set up FormoAnalyticsProvider in Your Application**

Wrap your entire React application in the `FormoAnalyticsProvider` provided by the SDK.

```jsx 
//App.tsx (or App.js)
import React from 'react';
import ReactDOM from 'react-dom/client';
import { FormoAnalyticsProvider } from '@formo/analytics';
import App from './App';

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);

root.render(
  <React.StrictMode>
    <FormoAnalyticsProvider apiKey="YOUR_API_KEY">
      <App />
    </FormoAnalyticsProvider>
  </React.StrictMode>
);
```

**3. Tracking Events**

You can use the `useFormoAnalytics` hook from the SDK to track user interactions.

Example: Tracking a Custom Event

```jsx
import React, { useEffect } from 'react';
import { useFormoAnalytics } from '@formo/analytics';

const HomePage = () => {
  const analytics = useFormoAnalytics();

  useEffect(() => {
    // Track a custom event
    analytics.track('custom_event', { key: 'value' });
  }, [analytics]);

  return <div>Welcome to the Home Page!</div>;
};

export default HomePage;
```

**4. Folder Structure Example**

```
/src
 ├── /components
 │    └── HomePage.tsx
 ├── /App.tsx
 └── /index.tsx (or index.js)
```

---

### Next.js Application

**1. Install the npm package:**

Install `@formo/analytics` via yarn or npm:

```jsx
yarn add @formo/analytics
```

or

```jsx
npm install @formo/analytics --save
```

**2. Set up the `FormoAnalyticsProvider` in your application:**

```jsx
// AnalyticsProvider.tsx

'use client';

import { FormoAnalytics, FormoAnalyticsProvider } from '@formo/analytics';
import React, { FC, useEffect } from 'react';

type FormoAnalyticsProviderProps = {
  apiKey: string,
  children: React.ReactNode,
};

// The provider component
export const AnalyticsProvider: FC<FormoAnalyticsProviderProps> = ({
  apiKey,
  children,
}) => {
  return apiKey ? (
    <FormoAnalyticsProvider apiKey={apiKey} options={options}>
      {children}
    </FormoAnalyticsProvider>
  ) : (
    children
  );
};

export default AnalyticsProvider;
```

**3. Integrating the Provider in Your Root Layout**

Wrap your application with the newly created `AnalyticsProvider` in your main layout file:

```jsx
import { AnalyticsProvider } from './AnalyticsProvider';

export default function RootLayout({
  children,
}: {
  children: React.ReactNode,
}) {
    if (!API_KEY) {
    console.log("API key is missing! Create a .env file based on .env.example and add your API key.");
  }
  
  return (
    <html lang='en'>
      <body>
        <AnalyticsProvider apiKey='YOUR_API_KEY'>
          Your Page Content
        </AnalyticsProvider>
      </body>
    </html>
  );
}
```

**4. Using the SDK**

Once the SDK is initialized, you can use its methods to track events and user interactions. Here’s how to do that:

```jsx
import { useFormoAnalytics } from '@formo/analytics';
import React, { useEffect } from 'react';

const YourComponent = () => {
  const analytics = useFormoAnalytics();

  useEffect(() => {
    const track = async () => {
      try {
        analytics.track('custom_event', { key: 'value' }); // Track a custom event
      } catch (error) {
        console.error('Failed to track event', error);
      }
    };

    track();
  }, [analytics]);

  return <div>Your Component Content</div>;
};
```

# Development Notes

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
yarn publish
```

or:

```jsx
npm run publish
```

# Troubleshooting

**API Key Not Provided:** Ensure you pass a valid apiKey when initializing the SDK.
**SDK Not Initialized:** If you encounter issues with initialization, check the console logs for errors and ensure the project ID and API key are correct.
**Network Errors:** Verify that the analytics service URL is accessible from your network.
