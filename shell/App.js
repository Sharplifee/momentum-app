import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { WebView } from "react-native-webview";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";

/**
 * Momentum Landscaping — customer app.
 *
 * This is a shell, not a second product. Every screen the customer sees is the
 * customer web app at momentumlandscapingut.com/app — same deployment as the
 * public site, which is why a desktop customer signs in at the same address and
 * why the two can never drift apart. Rebuilding those screens natively would
 * mean two codebases to keep in step for no gain, so the only native code here
 * is what a webview genuinely cannot do: ask iOS for a push token and hand
 * notification taps back to the page.
 *
 * Unlike the crew app there is no background location — that is crew-only.
 */

// The customer app is a hash route on the main site, served by the momentum-site
// project. portal.momentumlandscapingut.com was retired on 2026-08-04 and now
// returns DEPLOYMENT_NOT_FOUND, so nothing may point at it.
const APP_URL = Constants.expoConfig?.extra?.appUrl ?? "https://momentumlandscapingut.com/app";
const BUNDLE_ID = Constants.expoConfig?.ios?.bundleIdentifier ?? "com.momentumlandscapingut.customer";
const APP_VERSION = Constants.expoConfig?.version ?? "1.0.0";
const APP_HOSTS = new Set(["momentumlandscapingut.com", "www.momentumlandscapingut.com"]);

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

/**
 * Asks iOS for the APNs device token.
 *
 * getDevicePushTokenAsync, never getExpoPushTokenAsync — the server talks to
 * Apple directly, and an Expo relay token comes back BadDeviceToken.
 */
async function getDeviceToken() {
  const existing = await Notifications.getPermissionsAsync();
  let status = existing.status;
  if (status !== "granted") {
    const asked = await Notifications.requestPermissionsAsync();
    status = asked.status;
  }
  if (status !== "granted") return null;

  const { data } = await Notifications.getDevicePushTokenAsync();
  return typeof data === "string" ? data : null;
}

/**
 * Registration runs inside the page rather than from native, because the
 * portal owns the signed-in session and the shell has no copy of it. The page
 * exposes momentumRegisterPush once it mounts; if the token arrives first it
 * parks on window.__momentumPush and the page picks it up on hydration.
 */
function pushBridgeScript(token) {
  const t = JSON.stringify(token);
  const b = JSON.stringify(BUNDLE_ID);
  const v = JSON.stringify(APP_VERSION);
  return `(function () {
    window.__momentumPush = { token: ${t}, bundleId: ${b}, appVersion: ${v} };
    if (typeof window.momentumRegisterPush === 'function') {
      window.momentumRegisterPush(${t}, ${b}, ${v});
    }
  })(); true;`;
}

export default function App() {
  const webRef = useRef(null);
  const [pushToken, setPushToken] = useState(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    getDeviceToken()
      .then(setPushToken)
      .catch(() => {
        // Declining notifications is a legitimate choice — the app still works,
        // the customer just gets reminders by text instead.
      });
  }, []);

  // Re-inject whenever either side becomes ready, in whichever order that happens.
  useEffect(() => {
    if (pushToken && webRef.current) webRef.current.injectJavaScript(pushBridgeScript(pushToken));
  }, [pushToken]);

  // A notification tap should land on the thing it was about, not the home tab.
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const path = response?.notification?.request?.content?.data?.url;
      // The page keeps its screen in React state and never reads location.hash,
      // so setting the hash did nothing and every tap landed on whatever screen
      // was already open. window.momentumOpen is the page's own entry point; if
      // the tap beats the page to mount, park it and let the page drain it.
      if (typeof path === "string" && path.trim() && webRef.current) {
        const route = JSON.stringify(path.replace(/^#/, "").trim());
        webRef.current.injectJavaScript(
          `(function(){
             if (typeof window.momentumOpen === 'function') { window.momentumOpen(${route}); }
             else { window.__momentumPendingRoute = ${route}; }
           })(); true;`
        );
      }
    });
    return () => sub.remove();
  }, []);

  const onLoadEnd = useCallback(() => {
    setLoading(false);
    setRefreshing(false);
    if (pushToken && webRef.current) webRef.current.injectJavaScript(pushBridgeScript(pushToken));
  }, [pushToken]);

  const reload = useCallback(() => {
    setFailed(false);
    setLoading(true);
    webRef.current?.reload();
  }, []);

  /**
   * Keep the portal inside the app and send everything else — Stripe's hosted
   * checkout, tel: and sms: links, our own legal pages — to the system, so a
   * customer never gets stranded on a page with no way back.
   */
  const onShouldStartLoad = useCallback((request) => {
    const { url } = request;
    if (!/^https?:/i.test(url)) {
      Linking.openURL(url).catch(() => {});
      return false;
    }
    let host;
    try {
      host = new URL(url).host;
    } catch {
      return false;
    }
    if (APP_HOSTS.has(host)) return true;
    Linking.openURL(url).catch(() => {});
    return false;
  }, []);

  if (failed) {
    return (
      <SafeAreaProvider>
        <SafeAreaView style={styles.fill}>
          <StatusBar style="light" />
          <ScrollView
            contentContainerStyle={styles.center}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={reload} tintColor="#7FB8BE" />}
          >
            <Text style={styles.title}>Can't reach Momentum</Text>
            <Text style={styles.body}>
              Check your signal and try again. Your schedule and messages are safe — nothing was lost.
            </Text>
            <TouchableOpacity style={styles.button} onPress={reload} accessibilityRole="button">
              <Text style={styles.buttonText}>Try again</Text>
            </TouchableOpacity>
          </ScrollView>
        </SafeAreaView>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.fill} edges={["top", "left", "right"]}>
        <StatusBar style="light" />
        <WebView
          ref={webRef}
          source={{ uri: APP_URL }}
          style={styles.fill}
          // The portal writes a cookie session; without shared storage the
          // customer would be asked to sign in on every cold start.
          sharedCookiesEnabled
          thirdPartyCookiesEnabled
          originWhitelist={["https://*"]}
          onShouldStartLoadWithRequest={onShouldStartLoad}
          onLoadEnd={onLoadEnd}
          onError={() => {
            setLoading(false);
            setFailed(true);
          }}
          onHttpError={({ nativeEvent }) => {
            // 4xx on a sub-resource is normal; only a failed document is fatal.
            if (nativeEvent.statusCode >= 500) setFailed(true);
          }}
          allowsBackForwardNavigationGestures
          pullToRefreshEnabled
          decelerationRate="normal"
          allowsInlineMediaPlayback
          setSupportMultipleWindows={false}
          applicationNameForUserAgent={`MomentumCustomer/${APP_VERSION}`}
          keyboardDisplayRequiresUserAction={false}
        />
        {loading && (
          <View style={styles.loading} pointerEvents="none">
            <ActivityIndicator size="large" color="#7FB8BE" />
          </View>
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: "#0F1720" },
  center: { flexGrow: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  title: { color: "#fff", fontSize: 22, fontWeight: "700", marginBottom: 8, textAlign: "center" },
  body: { color: "rgba(255,255,255,0.65)", fontSize: 15, textAlign: "center", lineHeight: 22 },
  button: {
    marginTop: 24,
    backgroundColor: "#7FB8BE",
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: 14,
  },
  buttonText: { color: "#0F1720", fontSize: 16, fontWeight: "700" },
  loading: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#0F1720",
  },
});

export const _platform = Platform.OS;
