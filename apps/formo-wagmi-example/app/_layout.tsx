import "react-native-get-random-values";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { FormoAnalyticsProvider } from "@formo/react-native-analytics";
import { wagmiConfig, queryClient } from "@/config/wagmi";
import { FORMO_WRITE_KEY, formoOptions } from "@/config/formo";
import { SafeAreaProvider } from "react-native-safe-area-context";

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <FormoAnalyticsProvider
            writeKey={FORMO_WRITE_KEY}
            asyncStorage={AsyncStorage}
            options={formoOptions}
          >
            <StatusBar style="light" />
            <Stack
              screenOptions={{
                headerStyle: {
                  backgroundColor: "#1a1a2e",
                },
                headerTintColor: "#fff",
                contentStyle: {
                  backgroundColor: "#1a1a2e",
                },
              }}
            >
              <Stack.Screen
                name="index"
                options={{
                  title: "Formo Analytics Demo",
                }}
              />
              <Stack.Screen
                name="wallet"
                options={{
                  title: "Wallet",
                }}
              />
              <Stack.Screen
                name="events"
                options={{
                  title: "Track Events",
                }}
              />
              <Stack.Screen
                name="transactions"
                options={{
                  title: "Transactions",
                }}
              />
              <Stack.Screen
                name="settings"
                options={{
                  title: "Settings",
                }}
              />
            </Stack>
          </FormoAnalyticsProvider>
        </QueryClientProvider>
      </WagmiProvider>
    </SafeAreaProvider>
  );
}
