import { useEffect } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
} from "react-native";
import { useFormo } from "@formo/react-native-analytics";
import { useAccount, useDisconnect, useChainId, useSwitchChain } from "wagmi";
import { useAppKit } from "@reown/appkit/react";
import { chains } from "@/config/wagmi";

export default function WalletScreen() {
  const formo = useFormo();
  const { address, isConnected, connector } = useAccount();
  const chainId = useChainId();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const { open } = useAppKit();

  // Track screen view
  useEffect(() => {
    formo.screen("Wallet", {
      isConnected,
      address: address || null,
      chainId,
    });
  }, []);

  const handleConnect = () => {
    formo.track("Connect Button Pressed", {
      screen: "Wallet",
      currentlyConnected: isConnected,
    });
    open();
  };

  const handleDisconnect = () => {
    formo.track("Disconnect Button Pressed", {
      screen: "Wallet",
      address,
      chainId,
    });
    disconnect();
    Alert.alert("Disconnected", "Wallet has been disconnected");
  };

  const handleSwitchChain = (newChainId: number) => {
    formo.track("Chain Switch Initiated", {
      screen: "Wallet",
      fromChainId: chainId,
      toChainId: newChainId,
    });
    switchChain({ chainId: newChainId });
  };

  const currentChain = chains.find((c) => c.id === chainId);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Connection Status */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Connection Status</Text>

        {isConnected ? (
          <View style={styles.connectedInfo}>
            <View style={styles.statusRow}>
              <Text style={styles.label}>Status</Text>
              <View style={styles.statusBadge}>
                <Text style={styles.statusBadgeText}>Connected</Text>
              </View>
            </View>

            <View style={styles.statusRow}>
              <Text style={styles.label}>Address</Text>
              <Text style={styles.valueText}>
                {address?.slice(0, 10)}...{address?.slice(-8)}
              </Text>
            </View>

            <View style={styles.statusRow}>
              <Text style={styles.label}>Network</Text>
              <Text style={styles.valueText}>
                {currentChain?.name || "Unknown"}
              </Text>
            </View>

            <View style={styles.statusRow}>
              <Text style={styles.label}>Chain ID</Text>
              <Text style={styles.valueText}>{chainId}</Text>
            </View>

            <View style={styles.statusRow}>
              <Text style={styles.label}>Connector</Text>
              <Text style={styles.valueText}>{connector?.name || "Unknown"}</Text>
            </View>

            <TouchableOpacity
              style={styles.disconnectButton}
              onPress={handleDisconnect}
            >
              <Text style={styles.disconnectButtonText}>Disconnect Wallet</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.disconnectedInfo}>
            <Text style={styles.disconnectedText}>No wallet connected</Text>
            <TouchableOpacity
              style={styles.connectButton}
              onPress={handleConnect}
            >
              <Text style={styles.connectButtonText}>Connect Wallet</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      {/* Network Switcher */}
      {isConnected && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Switch Network</Text>
          <View style={styles.chainList}>
            {chains.map((chain) => (
              <TouchableOpacity
                key={chain.id}
                style={[
                  styles.chainButton,
                  chainId === chain.id && styles.chainButtonActive,
                ]}
                onPress={() => handleSwitchChain(chain.id)}
                disabled={chainId === chain.id}
              >
                <Text
                  style={[
                    styles.chainButtonText,
                    chainId === chain.id && styles.chainButtonTextActive,
                  ]}
                >
                  {chain.name}
                </Text>
                {chainId === chain.id && (
                  <Text style={styles.currentLabel}>Current</Text>
                )}
              </TouchableOpacity>
            ))}
          </View>
        </View>
      )}

      {/* Analytics Info */}
      <View style={styles.infoCard}>
        <Text style={styles.infoTitle}>Auto-Tracked Events</Text>
        <Text style={styles.infoText}>
          With Wagmi integration enabled, the following events are automatically
          tracked:{"\n\n"}
          • Wallet Connect{"\n"}
          • Wallet Disconnect{"\n"}
          • Chain/Network Changes{"\n"}
          • Signature Requests{"\n"}
          • Transactions
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
  card: {
    backgroundColor: "#252540",
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
  },
  cardTitle: {
    fontSize: 18,
    fontWeight: "600",
    color: "#fff",
    marginBottom: 16,
  },
  connectedInfo: {
    gap: 12,
  },
  statusRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  label: {
    fontSize: 14,
    color: "#a0a0b0",
  },
  valueText: {
    fontSize: 14,
    color: "#fff",
    fontFamily: "monospace",
  },
  statusBadge: {
    backgroundColor: "#22543d",
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
  },
  statusBadgeText: {
    color: "#4ade80",
    fontSize: 12,
    fontWeight: "600",
  },
  disconnectButton: {
    backgroundColor: "#7f1d1d",
    padding: 14,
    borderRadius: 12,
    alignItems: "center",
    marginTop: 8,
  },
  disconnectButtonText: {
    color: "#fca5a5",
    fontSize: 16,
    fontWeight: "600",
  },
  disconnectedInfo: {
    alignItems: "center",
    gap: 16,
  },
  disconnectedText: {
    fontSize: 16,
    color: "#a0a0b0",
  },
  connectButton: {
    backgroundColor: "#3b82f6",
    padding: 16,
    borderRadius: 12,
    alignItems: "center",
    width: "100%",
  },
  connectButtonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  chainList: {
    gap: 8,
  },
  chainButton: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: "#1a1a2e",
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#3a3a5a",
  },
  chainButtonActive: {
    backgroundColor: "#1e3a8a",
    borderColor: "#3b82f6",
  },
  chainButtonText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "500",
  },
  chainButtonTextActive: {
    color: "#93c5fd",
  },
  currentLabel: {
    fontSize: 12,
    color: "#3b82f6",
    fontWeight: "600",
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
    lineHeight: 22,
  },
});
