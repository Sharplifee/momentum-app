import { useEffect, useState } from "react";
import { View, Text, StyleSheet, ActivityIndicator } from "react-native";
import { currentCoords, getForecast } from "./weather";

/** Current temperature and conditions. No interpretation, no advice. */
export function WeatherBar() {
  const [state, setState] = useState({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const coords = (await currentCoords()) ?? { lat: 40.5622, lng: -111.9297 };
      const data = await getForecast(coords);
      if (!cancelled) setState(data ? { status: "ok", data } : { status: "off" });
    })();
    return () => { cancelled = true; };
  }, []);

  if (state.status === "off") return null;
  if (state.status === "loading") {
    return (
      <View style={styles.bar}>
        <ActivityIndicator size="small" color="#7FB8BE" />
      </View>
    );
  }

  const { data } = state;
  const today = data.days?.[0];
  const now = Math.round(data.current?.tempF ?? today?.highF ?? 0);
  const hi = Math.round(today?.highF ?? 0);
  const lo = Math.round(today?.lowF ?? 0);

  return (
    <View style={styles.bar}>
      <Text style={styles.temp}>{now}°</Text>
      <Text style={styles.range}>H {hi}°  L {lo}°</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row", alignItems: "center", gap: 12,
    paddingHorizontal: 16, paddingVertical: 10,
    backgroundColor: "#0F1720", borderBottomWidth: 1, borderBottomColor: "#22303D",
    minHeight: 44,
  },
  temp: { color: "#E8F1F3", fontSize: 17, fontWeight: "600" },
  range: { color: "#93A7B2", fontSize: 13 },
});
