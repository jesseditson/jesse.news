import { startRain, type Rain } from "./rain.js";

const CACHE_KEY = "jesse.news:weather";
const OFF_KEY = "jesse.news:rain-off";
const CACHE_MS = 30 * 60 * 1000;

// WMO weather codes: drizzle, rain, freezing rain, showers, thunderstorms.
const WET_CODES = new Map<number, number>([
  [51, 0.25], [53, 0.35], [55, 0.5], [56, 0.35], [57, 0.5],
  [61, 0.4], [63, 0.6], [65, 0.85], [66, 0.5], [67, 0.8],
  [80, 0.45], [81, 0.65], [82, 0.9], [95, 0.8], [96, 0.9], [99, 1],
]);

interface Report {
  raining: boolean;
  intensity: number;
}

interface CachedReport extends Report {
  at: number;
}

interface GeoResponse {
  latitude?: string;
  longitude?: string;
}

interface ForecastResponse {
  current?: {
    precipitation?: number;
    rain?: number;
    showers?: number;
    weather_code?: number;
  };
}

const storage = {
  get(store: Storage, key: string): string | null {
    try {
      return store.getItem(key);
    } catch {
      return null;
    }
  },
  set(store: Storage, key: string, value: string | null): void {
    try {
      if (value === null) store.removeItem(key);
      else store.setItem(key, value);
    } catch {
      // Private mode: the choice just won't stick.
    }
  },
};

async function getJSON<T>(url: string, timeout = 5000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { signal: controller.signal, credentials: "omit", referrerPolicy: "no-referrer" });
    if (!response.ok) throw new Error(String(response.status));
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function lookup(): Promise<Report> {
  const cached = storage.get(sessionStorage, CACHE_KEY);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as CachedReport;
      if (Date.now() - parsed.at < CACHE_MS) return parsed;
    } catch {
      // Ignore a corrupt cache entry.
    }
  }

  const geo = await getJSON<GeoResponse>("https://get.geojs.io/v1/ip/geo.json");
  const latitude = Number.parseFloat(geo.latitude ?? "");
  const longitude = Number.parseFloat(geo.longitude ?? "");
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) throw new Error("no location");

  const params = new URLSearchParams({
    latitude: latitude.toFixed(1),
    longitude: longitude.toFixed(1),
    current: "precipitation,rain,showers,weather_code",
  });
  const weather = await getJSON<ForecastResponse>(`https://api.open-meteo.com/v1/forecast?${params}`);
  const now = weather.current ?? {};
  const millimeters = Math.max(now.precipitation ?? 0, (now.rain ?? 0) + (now.showers ?? 0));
  const coded = now.weather_code === undefined ? undefined : WET_CODES.get(now.weather_code);
  const raining = millimeters > 0 || coded !== undefined;
  const intensity = raining ? Math.min(1, Math.max(coded ?? 0.3, millimeters / 4)) : 0;

  const result: CachedReport = { at: Date.now(), raining, intensity };
  storage.set(sessionStorage, CACHE_KEY, JSON.stringify(result));
  return result;
}

export async function initWeather({ prefersReducedMotion }: { prefersReducedMotion: boolean }): Promise<void> {
  const forced = new URLSearchParams(window.location.search).get("weather");
  let report: Report;
  if (forced === "rain") report = { raining: true, intensity: 0.6 };
  else if (forced) report = { raining: false, intensity: 0 };
  else {
    try {
      report = await lookup();
    } catch {
      return;
    }
  }
  if (!report.raining) return;

  let rain: Promise<Rain | null> | null = null;
  const start = () => {
    rain = startRain({ intensity: report.intensity, prefersReducedMotion }).catch(() => null);
  };
  const stop = () => {
    rain?.then((r) => r?.stop());
    rain = null;
  };

  const sync = () => {
    const off = storage.get(localStorage, OFF_KEY) === "1";
    document.querySelectorAll<HTMLElement>("[data-weather-note]").forEach((note) => {
      note.hidden = false;
      const text = note.querySelector("[data-weather-text]");
      if (text) text.textContent = "It's raining where you are.";
      const toggle = note.querySelector("[data-weather-toggle]");
      if (toggle) toggle.textContent = off ? "Let it rain" : "Wipe the glass";
    });
    if (off && rain) stop();
    if (!off && !rain) start();
  };

  document.addEventListener("click", (event) => {
    if (!(event.target as Element | null)?.closest?.("[data-weather-toggle]")) return;
    const off = storage.get(localStorage, OFF_KEY) === "1";
    storage.set(localStorage, OFF_KEY, off ? null : "1");
    sync();
  });

  sync();
}
