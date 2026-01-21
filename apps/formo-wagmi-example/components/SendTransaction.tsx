import { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Alert,
  ActivityIndicator,
} from "react-native";
import { useFormo, TransactionStatus } from "@formo/react-native-analytics";
import { useAccount, useChainId, useSendTransaction } from "wagmi";
import { parseEther } from "viem";

export function SendTransaction() {
  const formo = useFormo();
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { sendTransactionAsync, isPending } = useSendTransaction();

  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const validateInput = (): boolean => {
    setError(null);

    if (!recipient || !recipient.startsWith("0x") || recipient.length !== 42) {
      setError("Invalid recipient address");
      return false;
    }

    // Parse and validate amount - check for NaN explicitly
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      setError("Please enter a valid amount greater than 0");
      return false;
    }

    return true;
  };

  const handleSendTransaction = async () => {
    if (!isConnected || !address) {
      Alert.alert("Error", "Please connect your wallet first");
      return;
    }

    if (!validateInput()) {
      return;
    }

    setTxHash(null);
    setError(null);

    try {
      // Track transaction started
      formo.transaction({
        status: TransactionStatus.STARTED,
        chainId,
        address,
        to: recipient,
        value: parseEther(amount).toString(),
      });

      // Use sendTransactionAsync to get the hash (not sendTransaction which returns void)
      const hash = await sendTransactionAsync({
        to: recipient as `0x${string}`,
        value: parseEther(amount),
      });

      // Track transaction broadcasted with hash
      formo.transaction({
        status: TransactionStatus.BROADCASTED,
        chainId,
        address,
        to: recipient,
        value: parseEther(amount).toString(),
        transactionHash: hash,
      });

      setTxHash(hash);
      Alert.alert("Success", `Transaction sent!\nHash: ${hash.slice(0, 20)}...`);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Transaction failed";
      setError(errorMessage);

      // Track transaction rejected/failed
      formo.transaction({
        status: TransactionStatus.REJECTED,
        chainId,
        address,
        to: recipient,
        value: amount ? parseEther(amount).toString() : "0",
      });

      // Check if user rejected
      if (errorMessage.includes("rejected") || errorMessage.includes("denied")) {
        Alert.alert("Cancelled", "Transaction was rejected by user");
      } else {
        Alert.alert("Error", errorMessage);
      }
    }
  };

  if (!isConnected) {
    return (
      <View style={styles.container}>
        <Text style={styles.disabledText}>
          Connect your wallet to send transactions
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Send Transaction</Text>

      <Text style={styles.label}>Recipient Address</Text>
      <TextInput
        style={styles.input}
        value={recipient}
        onChangeText={setRecipient}
        placeholder="0x..."
        placeholderTextColor="#666"
        autoCapitalize="none"
        autoCorrect={false}
      />

      <Text style={styles.label}>Amount (ETH)</Text>
      <TextInput
        style={styles.input}
        value={amount}
        onChangeText={setAmount}
        placeholder="0.01"
        placeholderTextColor="#666"
        keyboardType="decimal-pad"
      />

      {error && <Text style={styles.errorText}>{error}</Text>}

      {txHash && (
        <View style={styles.successBox}>
          <Text style={styles.successText}>Transaction Sent!</Text>
          <Text style={styles.hashText}>{txHash}</Text>
        </View>
      )}

      <TouchableOpacity
        style={[styles.button, isPending && styles.buttonDisabled]}
        onPress={handleSendTransaction}
        disabled={isPending}
      >
        {isPending ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.buttonText}>Send Transaction</Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: "#252540",
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
  },
  title: {
    fontSize: 18,
    fontWeight: "600",
    color: "#fff",
    marginBottom: 16,
  },
  label: {
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
    fontFamily: "monospace",
  },
  button: {
    backgroundColor: "#3b82f6",
    padding: 16,
    borderRadius: 12,
    alignItems: "center",
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  errorText: {
    color: "#ef4444",
    fontSize: 14,
    marginBottom: 16,
  },
  successBox: {
    backgroundColor: "#14532d",
    borderRadius: 12,
    padding: 14,
    marginBottom: 16,
  },
  successText: {
    color: "#4ade80",
    fontSize: 14,
    fontWeight: "600",
    marginBottom: 4,
  },
  hashText: {
    color: "#86efac",
    fontSize: 12,
    fontFamily: "monospace",
  },
  disabledText: {
    color: "#a0a0b0",
    fontSize: 14,
    textAlign: "center",
    padding: 20,
  },
});
