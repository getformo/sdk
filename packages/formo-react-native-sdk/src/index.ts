/**
 * Formo Analytics SDK for React Native
 *
 * Track wallet events and user analytics in mobile dApps
 *
 * @example
 * ```tsx
 * import AsyncStorage from '@react-native-async-storage/async-storage';
 * import { FormoAnalyticsProvider, useFormo } from '@formo/react-native-analytics';
 *
 * // Wrap your app with the provider
 * function App() {
 *   return (
 *     <FormoAnalyticsProvider
 *       writeKey="your-write-key"
 *       asyncStorage={AsyncStorage}
 *       options={{
 *         wagmi: { config, queryClient },
 *         app: { name: 'MyApp', version: '1.0.0' },
 *       }}
 *     >
 *       <YourApp />
 *     </FormoAnalyticsProvider>
 *   );
 * }
 *
 * // Use the hook in your components
 * function MyScreen() {
 *   const formo = useFormo();
 *
 *   useEffect(() => {
 *     formo.screen('Home');
 *   }, []);
 *
 *   return <View>...</View>;
 * }
 * ```
 */

// Main exports
export { FormoAnalytics } from "./FormoAnalytics";
export {
  FormoAnalyticsProvider,
  FormoAnalyticsContext,
  useFormo,
} from "./FormoAnalyticsProvider";

// Types
export * from "./types";

// Event types for manual event tracking
export { SignatureStatus, TransactionStatus } from "./types/events";

// Storage types for custom storage implementations
export type { AsyncStorageInterface } from "./lib/storage";
