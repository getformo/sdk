import { useState, useEffect } from "react";
import {
  View,
  Text,
  StyleSheet,
  Switch,
  ScrollView,
  Alert,
} from "react-native";
import { useFormo } from "@formo/react-native-analytics";

export default function SettingsScreen() {
  const formo = useFormo();
  const [isOptedOut, setIsOptedOut] = useState(false);

  // Re-run when formo changes from no-op defaultContext to real SDK
  // so consent state is read correctly and screen view is tracked
  useEffect(() => {
    setIsOptedOut(formo.hasOptedOutTracking());
    formo.screen("Settings");
  }, [formo]);

  const handleToggleTracking = (value: boolean) => {
    if (value) {
      // User is opting OUT
      // IMPORTANT: Track the event BEFORE opting out, so it gets recorded
      formo.track("tracking_disabled", {
        action: "opt_out",
        screen: "Settings",
      });

      // Now opt out - this disables tracking
      formo.optOutTracking();
      setIsOptedOut(true);

      Alert.alert(
        "Tracking Disabled",
        "Analytics tracking has been disabled. Your data will not be collected."
      );
    } else {
      // User is opting back IN
      // First opt in to enable tracking
      formo.optInTracking();
      setIsOptedOut(false);

      // Now track the event (tracking is enabled)
      formo.track("tracking_enabled", {
        action: "opt_in",
        screen: "Settings",
      });

      Alert.alert(
        "Tracking Enabled",
        "Analytics tracking has been enabled."
      );
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Privacy Settings</Text>

        <View style={styles.settingRow}>
          <View style={styles.settingInfo}>
            <Text style={styles.settingLabel}>Disable Analytics</Text>
            <Text style={styles.settingDescription}>
              When enabled, no analytics data will be collected or sent
            </Text>
          </View>
          <Switch
            value={isOptedOut}
            onValueChange={handleToggleTracking}
            trackColor={{ false: "#3a3a5a", true: "#3b82f6" }}
            thumbColor={isOptedOut ? "#93c5fd" : "#f4f3f4"}
          />
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Tracking Status</Text>

        <View style={styles.statusRow}>
          <Text style={styles.statusLabel}>Current Status</Text>
          <View style={[
            styles.statusBadge,
            isOptedOut ? styles.statusBadgeDisabled : styles.statusBadgeEnabled
          ]}>
            <Text style={[
              styles.statusBadgeText,
              isOptedOut ? styles.statusTextDisabled : styles.statusTextEnabled
            ]}>
              {isOptedOut ? "Disabled" : "Enabled"}
            </Text>
          </View>
        </View>
      </View>

      <View style={styles.infoCard}>
        <Text style={styles.infoTitle}>What We Track</Text>
        <Text style={styles.infoText}>
          When tracking is enabled, we collect:{"\n\n"}
          • Wallet connection events{"\n"}
          • Transaction and signature events{"\n"}
          • Screen views and navigation{"\n"}
          • Custom events you trigger{"\n\n"}
          We never collect your private keys or seed phrases.
        </Text>
      </View>

      <View style={styles.infoCard}>
        <Text style={styles.infoTitle}>GDPR Compliance</Text>
        <Text style={styles.infoText}>
          Your choice is respected and stored locally. When you opt out:{"\n\n"}
          • All tracking stops immediately{"\n"}
          • No data is sent to our servers{"\n"}
          • Your session data is cleared{"\n"}
          • You can opt back in at any time
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
  settingRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  settingInfo: {
    flex: 1,
    marginRight: 16,
  },
  settingLabel: {
    fontSize: 16,
    color: "#fff",
    fontWeight: "500",
    marginBottom: 4,
  },
  settingDescription: {
    fontSize: 13,
    color: "#a0a0b0",
  },
  statusRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  statusLabel: {
    fontSize: 14,
    color: "#a0a0b0",
  },
  statusBadge: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
  },
  statusBadgeEnabled: {
    backgroundColor: "#14532d",
  },
  statusBadgeDisabled: {
    backgroundColor: "#7f1d1d",
  },
  statusBadgeText: {
    fontSize: 12,
    fontWeight: "600",
  },
  statusTextEnabled: {
    color: "#4ade80",
  },
  statusTextDisabled: {
    color: "#fca5a5",
  },
  infoCard: {
    backgroundColor: "#1e1e3a",
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
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
