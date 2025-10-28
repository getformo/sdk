/**
 * Wagmi Integration for Formo Analytics
 * 
 * This module provides seamless integration between Wagmi and Formo Analytics,
 * enabling automatic tracking of wallet events with minimal setup.
 * 
 * @example Simple Provider Setup
 * ```tsx
 * import { WagmiProvider } from 'wagmi';
 * import { WagmiFormoProvider } from '@formo/analytics/wagmi';
 * 
 * function App() {
 *   return (
 *     <WagmiProvider config={wagmiConfig}>
 *       <WagmiFormoProvider writeKey="your-write-key">
 *         <YourApp />
 *       </WagmiFormoProvider>
 *     </WagmiProvider>
 *   );
 * }
 * ```
 * 
 * @example Drop-in Hook Replacements
 * ```tsx
 * // Just change your imports - everything else stays the same!
 * import { useSignMessage, useSendTransaction } from '@formo/analytics/wagmi';
 * 
 * function WalletComponent() {
 *   const { signMessage } = useSignMessage();
 *   const { sendTransaction } = useSendTransaction();
 *   
 *   // These hooks automatically track events to Formo
 *   const handleSign = () => signMessage({ message: "Hello World" });
 *   const handleSend = () => sendTransaction({ to: "0x...", value: parseEther("1") });
 *   
 *   return (
 *     <div>
 *       <button onClick={handleSign}>Sign Message</button>
 *       <button onClick={handleSend}>Send Transaction</button>
 *     </div>
 *   );
 * }
 * ```
 */

export { WagmiFormoProvider } from './WagmiFormoProvider';
export type { WagmiFormoProviderProps } from './WagmiFormoProvider';

// Drop-in replacement hooks (same names as Wagmi)
export { 
  useSignMessage,
  useSendTransaction,
  useFormoWallet
} from './drop-in-hooks';

// Re-export commonly used types for convenience
export type {
  Address,
  ChainID,
  SignatureStatus,
  TransactionStatus,
  IFormoEventProperties,
  IFormoEventContext
} from '../../types';
