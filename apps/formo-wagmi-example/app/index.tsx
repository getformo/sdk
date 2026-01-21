import { useEffect } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
} from "react-native";
import { Link } from "expo-router";
import { useFormo } from "@formo/react-native-analytics";
import { useAccount } from "wagmi";

export default function HomeScreen() {
  const formo = useFormo();
  const { address, isConnected } = useAccount();

  // Track screen view on mount
  useEffect(() => {
    formo.screen("Home", {
      isConnected,
      address: address || null,
    });
  }, []);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Text style={styles.title}>Formo Analytics</Text>
        <Text style={styles.subtitle}>React Native SDK Demo</Text>
      </View>

      <View style={styles.statusCard}>
        <Text style={styles.statusLabel}>Wallet Status</Text>
        <Text
          style={[
            styles.statusValue,
            { color: isConnected ? "#4ade80" : "#f87171" },
          ]}
        >
          {isConnected ? "Connected" : "Not Connected"}
        </Text>
        {address && (
          <Text style={styles.addressText}>
            {address.slice(0, 6)}...{address.slice(-4)}
          </Text>
        )}
      </View>

      <View style={styles.menuContainer}>
        <Link href="/wallet" asChild>
          <TouchableOpacity style={styles.menuButton}>
            <Text style={styles.menuButtonText}>🔗 Wallet Connection</Text>
            <Text style={styles.menuButtonSubtext}>
              Connect wallet and track events
            </Text>
          </TouchableOpacity>
        </Link>

        <Link href="/events" asChild>
          <TouchableOpacity style={styles.menuButton}>
            <Text style={styles.menuButtonText}>📊 Track Events</Text>
            <Text style={styles.menuButtonSubtext}>
              Send custom analytics events
            </Text>
          </TouchableOpacity>
        </Link>

        <Link href="/transactions" asChild>
          <TouchableOpacity style={styles.menuButton}>
            <Text style={styles.menuButtonText}>💸 Transactions</Text>
            <Text style={styles.menuButtonSubtext}>
              Sign messages and send transactions
            </Text>
          </TouchableOpacity>
        </Link>

        <Link href="/settings" asChild>
          <TouchableOpacity style={styles.menuButton}>
            <Text style={styles.menuButtonText}>⚙️ Settings</Text>
            <Text style={styles.menuButtonSubtext}>
              Privacy and tracking preferences
            </Text>
          </TouchableOpacity>
        </Link>
      </View>

      <View style={styles.infoCard}>
        <Text style={styles.infoTitle}>About This Demo</Text>
        <Text style={styles.infoText}>
          This app demonstrates the Formo React Native SDK with Wagmi
          integration. Wallet events like connect, disconnect, chain changes,
          signatures, and transactions are automatically tracked.
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#1a1a2e",
  },
  content: {
    padding: 20,
  },
  header: {
    alignItems: "center",
    marginBottom: 30,
  },
  title: {
    fontSize: 32,
    fontWeight: "bold",
    color: "#fff",
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: "#a0a0b0",
  },
  statusCard: {
    backgroundColor: "#252540",
    borderRadius: 16,
    padding: 20,
    alignItems: "center",
    marginBottom: 24,
  },
  statusLabel: {
    fontSize: 14,
    color: "#a0a0b0",
    marginBottom: 8,
  },
  statusValue: {
    fontSize: 20,
    fontWeight: "600",
  },
  addressText: {
    fontSize: 14,
    color: "#a0a0b0",
    marginTop: 8,
    fontFamily: "monospace",
  },
  menuContainer: {
    gap: 12,
    marginBottom: 24,
  },
  menuButton: {
    backgroundColor: "#252540",
    borderRadius: 16,
    padding: 20,
  },
  menuButtonText: {
    fontSize: 18,
    fontWeight: "600",
    color: "#fff",
    marginBottom: 4,
  },
  menuButtonSubtext: {
    fontSize: 14,
    color: "#a0a0b0",
  },
  infoCard: {
    backgroundColor: "#1e1e3a",
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: "#3a3a5a",
  },
  infoTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: "#fff",
    marginBottom: 8,
  },
  infoText: {
    fontSize: 14,
    color: "#a0a0b0",
    lineHeight: 20,
  },
});
