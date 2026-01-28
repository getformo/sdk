import { useEffect } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useFormo } from "@formo/react-native-analytics";
import { useAccount } from "wagmi";
import { SendTransaction, SignMessage } from "@/components";

export default function TransactionsScreen() {
  const formo = useFormo();
  const { isConnected } = useAccount();

  // formo starts as a no-op defaultContext and becomes the real SDK async,
  // so we must include it in deps to re-run when initialization completes.
  useEffect(() => {
    formo.screen("Transactions", {
      isConnected,
    });
  }, [formo]);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <SignMessage />
      <SendTransaction />

      {!isConnected && (
        <View style={styles.warningCard}>
          <Text style={styles.warningText}>
            Connect your wallet to send transactions and sign messages
          </Text>
        </View>
      )}

      <View style={styles.infoCard}>
        <Text style={styles.infoTitle}>Event Tracking</Text>
        <Text style={styles.infoText}>
          These components demonstrate manual transaction and signature event
          tracking. Each action records:{"\n\n"}
          • Signature: requested, confirmed, or rejected{"\n"}
          • Transaction: started, broadcasted, confirmed, rejected, or reverted
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
  warningCard: {
    backgroundColor: "#78350f",
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: "#92400e",
  },
  warningText: {
    color: "#fcd34d",
    fontSize: 14,
    textAlign: "center",
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
