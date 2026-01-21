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
import { useFormo, SignatureStatus } from "@formo/react-native-analytics";
import { useAccount, useChainId, useSignMessage } from "wagmi";

export function SignMessage() {
  const formo = useFormo();
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { signMessageAsync, isPending } = useSignMessage();

  const [message, setMessage] = useState("Hello from Formo!");
  const [signature, setSignature] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSignMessage = async () => {
    if (!isConnected || !address) {
      Alert.alert("Error", "Please connect your wallet first");
      return;
    }

    if (!message.trim()) {
      setError("Please enter a message to sign");
      return;
    }

    setSignature(null);
    setError(null);

    try {
      // Track signature requested
      formo.signature({
        status: SignatureStatus.REQUESTED,
        chainId,
        address,
        message,
      });

      // Use signMessageAsync to get the signature (not signMessage which returns void)
      const sig = await signMessageAsync({ message });

      // Track signature confirmed with hash
      formo.signature({
        status: SignatureStatus.CONFIRMED,
        chainId,
        address,
        message,
        signatureHash: sig,
      });

      setSignature(sig);
      Alert.alert("Success", "Message signed successfully!");
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Signing failed";
      setError(errorMessage);

      // Track signature rejected
      formo.signature({
        status: SignatureStatus.REJECTED,
        chainId,
        address,
        message,
      });

      // Check if user rejected
      if (errorMessage.includes("rejected") || errorMessage.includes("denied")) {
        Alert.alert("Cancelled", "Signature request was rejected by user");
      } else {
        Alert.alert("Error", errorMessage);
      }
    }
  };

  if (!isConnected) {
    return (
      <View style={styles.container}>
        <Text style={styles.disabledText}>
          Connect your wallet to sign messages
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Sign Message</Text>

      <Text style={styles.label}>Message to Sign</Text>
      <TextInput
        style={[styles.input, styles.multilineInput]}
        value={message}
        onChangeText={setMessage}
        placeholder="Enter your message..."
        placeholderTextColor="#666"
        multiline
        numberOfLines={3}
      />

      {error && <Text style={styles.errorText}>{error}</Text>}

      {signature && (
        <View style={styles.successBox}>
          <Text style={styles.successText}>Signature</Text>
          <Text style={styles.signatureText} numberOfLines={4}>
            {signature}
          </Text>
        </View>
      )}

      <TouchableOpacity
        style={[styles.button, isPending && styles.buttonDisabled]}
        onPress={handleSignMessage}
        disabled={isPending}
      >
        {isPending ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.buttonText}>Sign Message</Text>
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
  },
  multilineInput: {
    minHeight: 80,
    textAlignVertical: "top",
  },
  button: {
    backgroundColor: "#8b5cf6",
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
    backgroundColor: "#1e1b4b",
    borderRadius: 12,
    padding: 14,
    marginBottom: 16,
  },
  successText: {
    color: "#a78bfa",
    fontSize: 14,
    fontWeight: "600",
    marginBottom: 4,
  },
  signatureText: {
    color: "#c4b5fd",
    fontSize: 11,
    fontFamily: "monospace",
  },
  disabledText: {
    color: "#a0a0b0",
    fontSize: 14,
    textAlign: "center",
    padding: 20,
  },
});
