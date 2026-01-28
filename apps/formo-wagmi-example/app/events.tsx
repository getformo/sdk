import { useState, useEffect } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  TextInput,
  Alert,
} from "react-native";
import { useFormo, SignatureStatus, TransactionStatus } from "@formo/react-native-analytics";
import { useAccount, useChainId } from "wagmi";

export default function EventsScreen() {
  const formo = useFormo();
  const { address, isConnected } = useAccount();
  const chainId = useChainId();

  const [customEventName, setCustomEventName] = useState("button_clicked");
  const [customProperty, setCustomProperty] = useState("");
  const [eventsSent, setEventsSent] = useState(0);

  // Track screen view once SDK is ready
  // formo starts as a no-op defaultContext and becomes the real SDK async,
  // so we must include it in deps to re-run when initialization completes.
  useEffect(() => {
    formo.screen("Events", {
      isConnected,
    });
  }, [formo]);

  const sendEvent = (eventType: string, details?: string) => {
    setEventsSent((prev) => prev + 1);
    Alert.alert("Event Sent", `${eventType}${details ? `\n${details}` : ""}`);
  };

  // Track custom event
  const handleTrackCustomEvent = () => {
    const properties: Record<string, unknown> = {
      screen: "Events",
      timestamp: new Date().toISOString(),
    };

    if (customProperty) {
      properties.customValue = customProperty;
    }

    formo.track(customEventName, properties);
    sendEvent("track", `Event: ${customEventName}`);
  };

  // Track revenue event
  const handleTrackRevenue = () => {
    formo.track("purchase_completed", {
      revenue: 99.99,
      currency: "USD",
      productId: "premium-nft-001",
      productName: "Premium NFT",
      quantity: 1,
    });
    sendEvent("track (revenue)", "revenue: $99.99 USD");
  };

  // Track points event
  const handleTrackPoints = () => {
    formo.track("achievement_unlocked", {
      points: 500,
      achievementId: "first_transaction",
      achievementName: "First Transaction",
    });
    sendEvent("track (points)", "points: 500");
  };

  // Track volume event
  const handleTrackVolume = () => {
    formo.track("swap_completed", {
      volume: 1.5,
      fromToken: "ETH",
      toToken: "USDC",
      fromAmount: "1.5",
      toAmount: "3000",
    });
    sendEvent("track (volume)", "volume: 1.5 ETH");
  };

  // Manual identify
  const handleIdentify = () => {
    if (!address) {
      Alert.alert("Error", "Please connect wallet first");
      return;
    }

    formo.identify({
      address,
      userId: `user_${address.slice(2, 10)}`,
      providerName: "Manual Identify",
      rdns: "manual.identify.demo",
    });
    sendEvent("identify", `address: ${address.slice(0, 10)}...`);
  };

  // Manual connect event
  const handleManualConnect = () => {
    if (!address) {
      Alert.alert("Error", "Please connect wallet first");
      return;
    }

    formo.connect({
      chainId: chainId || 1,
      address,
    }, {
      source: "manual_button",
    });
    sendEvent("connect", `chainId: ${chainId}, address: ${address.slice(0, 10)}...`);
  };

  // Manual signature event
  const handleSignatureEvent = (status: SignatureStatus) => {
    if (!address) {
      Alert.alert("Error", "Please connect wallet first");
      return;
    }

    formo.signature({
      status,
      chainId,
      address,
      message: "Example message to sign",
      ...(status === SignatureStatus.CONFIRMED && {
        signatureHash: "0x" + "a".repeat(130),
      }),
    });
    sendEvent("signature", `status: ${status}`);
  };

  // Manual transaction event
  const handleTransactionEvent = (status: TransactionStatus) => {
    if (!address) {
      Alert.alert("Error", "Please connect wallet first");
      return;
    }

    formo.transaction({
      status,
      chainId: chainId || 1,
      address,
      to: "0x" + "b".repeat(40),
      value: "1000000000000000000",
      data: "0x",
      ...(status === TransactionStatus.BROADCASTED && {
        transactionHash: "0x" + "c".repeat(64),
      }),
    });
    sendEvent("transaction", `status: ${status}`);
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Event Counter */}
      <View style={styles.counterCard}>
        <Text style={styles.counterValue}>{eventsSent}</Text>
        <Text style={styles.counterLabel}>Events Sent This Session</Text>
      </View>

      {/* Custom Event */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Custom Track Event</Text>

        <Text style={styles.inputLabel}>Event Name</Text>
        <TextInput
          style={styles.input}
          value={customEventName}
          onChangeText={setCustomEventName}
          placeholder="e.g., button_clicked"
          placeholderTextColor="#666"
        />

        <Text style={styles.inputLabel}>Custom Property (optional)</Text>
        <TextInput
          style={styles.input}
          value={customProperty}
          onChangeText={setCustomProperty}
          placeholder="e.g., signup_form"
          placeholderTextColor="#666"
        />

        <TouchableOpacity
          style={styles.primaryButton}
          onPress={handleTrackCustomEvent}
        >
          <Text style={styles.primaryButtonText}>Send Track Event</Text>
        </TouchableOpacity>
      </View>

      {/* Semantic Events */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Semantic Events</Text>
        <Text style={styles.cardSubtitle}>
          Events with special properties for analytics
        </Text>

        <View style={styles.buttonGroup}>
          <TouchableOpacity
            style={styles.semanticButton}
            onPress={handleTrackRevenue}
          >
            <Text style={styles.semanticButtonText}>💰 Revenue Event</Text>
            <Text style={styles.semanticButtonSubtext}>$99.99 USD</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.semanticButton}
            onPress={handleTrackPoints}
          >
            <Text style={styles.semanticButtonText}>⭐ Points Event</Text>
            <Text style={styles.semanticButtonSubtext}>500 points</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.semanticButton}
            onPress={handleTrackVolume}
          >
            <Text style={styles.semanticButtonText}>📈 Volume Event</Text>
            <Text style={styles.semanticButtonSubtext}>1.5 ETH</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Wallet Events */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Manual Wallet Events</Text>
        <Text style={styles.cardSubtitle}>
          Manually trigger wallet events (usually auto-tracked with Wagmi)
        </Text>

        <View style={styles.buttonGroup}>
          <TouchableOpacity
            style={[styles.walletButton, !isConnected && styles.disabledButton]}
            onPress={handleIdentify}
            disabled={!isConnected}
          >
            <Text style={styles.walletButtonText}>Identify</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.walletButton, !isConnected && styles.disabledButton]}
            onPress={handleManualConnect}
            disabled={!isConnected}
          >
            <Text style={styles.walletButtonText}>Connect</Text>
          </TouchableOpacity>
        </View>

        {/* Signature Events */}
        <Text style={styles.sectionLabel}>Signature Events</Text>
        <View style={styles.buttonRow}>
          <TouchableOpacity
            style={[styles.smallButton, !isConnected && styles.disabledButton]}
            onPress={() => handleSignatureEvent(SignatureStatus.REQUESTED)}
            disabled={!isConnected}
          >
            <Text style={styles.smallButtonText}>Requested</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.smallButton, styles.successButton, !isConnected && styles.disabledButton]}
            onPress={() => handleSignatureEvent(SignatureStatus.CONFIRMED)}
            disabled={!isConnected}
          >
            <Text style={styles.smallButtonText}>Confirmed</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.smallButton, styles.errorButton, !isConnected && styles.disabledButton]}
            onPress={() => handleSignatureEvent(SignatureStatus.REJECTED)}
            disabled={!isConnected}
          >
            <Text style={styles.smallButtonText}>Rejected</Text>
          </TouchableOpacity>
        </View>

        {/* Transaction Events */}
        <Text style={styles.sectionLabel}>Transaction Events</Text>
        <View style={styles.buttonRow}>
          <TouchableOpacity
            style={[styles.smallButton, !isConnected && styles.disabledButton]}
            onPress={() => handleTransactionEvent(TransactionStatus.STARTED)}
            disabled={!isConnected}
          >
            <Text style={styles.smallButtonText}>Started</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.smallButton, styles.successButton, !isConnected && styles.disabledButton]}
            onPress={() => handleTransactionEvent(TransactionStatus.BROADCASTED)}
            disabled={!isConnected}
          >
            <Text style={styles.smallButtonText}>Broadcasted</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.smallButton, styles.errorButton, !isConnected && styles.disabledButton]}
            onPress={() => handleTransactionEvent(TransactionStatus.REJECTED)}
            disabled={!isConnected}
          >
            <Text style={styles.smallButtonText}>Rejected</Text>
          </TouchableOpacity>
        </View>
      </View>

      {!isConnected && (
        <View style={styles.warningCard}>
          <Text style={styles.warningText}>
            ⚠️ Connect your wallet to test wallet-specific events
          </Text>
        </View>
      )}
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
  counterCard: {
    backgroundColor: "#3b82f6",
    borderRadius: 16,
    padding: 24,
    alignItems: "center",
    marginBottom: 16,
  },
  counterValue: {
    fontSize: 48,
    fontWeight: "bold",
    color: "#fff",
  },
  counterLabel: {
    fontSize: 14,
    color: "#93c5fd",
    marginTop: 4,
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
    marginBottom: 4,
  },
  cardSubtitle: {
    fontSize: 14,
    color: "#a0a0b0",
    marginBottom: 16,
  },
  inputLabel: {
    fontSize: 14,
    color: "#a0a0b0",
    marginBottom: 8,
  },
  input: {
    backgroundColor: "#1a1a2e",
    borderRadius: 12,
    padding: 14,
    color: "#fff",
    fontSize: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: "#3a3a5a",
  },
  primaryButton: {
    backgroundColor: "#3b82f6",
    padding: 16,
    borderRadius: 12,
    alignItems: "center",
  },
  primaryButtonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  buttonGroup: {
    gap: 12,
  },
  semanticButton: {
    backgroundColor: "#1a1a2e",
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#3a3a5a",
  },
  semanticButtonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "500",
  },
  semanticButtonSubtext: {
    color: "#a0a0b0",
    fontSize: 13,
    marginTop: 4,
  },
  walletButton: {
    flex: 1,
    backgroundColor: "#1a1a2e",
    padding: 14,
    borderRadius: 12,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#3a3a5a",
  },
  walletButtonText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "500",
  },
  sectionLabel: {
    fontSize: 14,
    color: "#a0a0b0",
    marginTop: 16,
    marginBottom: 8,
  },
  buttonRow: {
    flexDirection: "row",
    gap: 8,
  },
  smallButton: {
    flex: 1,
    backgroundColor: "#1a1a2e",
    padding: 12,
    borderRadius: 8,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#3a3a5a",
  },
  smallButtonText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "500",
  },
  successButton: {
    borderColor: "#22543d",
    backgroundColor: "#14532d",
  },
  errorButton: {
    borderColor: "#7f1d1d",
    backgroundColor: "#450a0a",
  },
  disabledButton: {
    opacity: 0.5,
  },
  warningCard: {
    backgroundColor: "#78350f",
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: "#92400e",
  },
  warningText: {
    color: "#fcd34d",
    fontSize: 14,
    textAlign: "center",
  },
});
