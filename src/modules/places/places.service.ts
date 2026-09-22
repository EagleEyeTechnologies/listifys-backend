/**
 * Google Places / Geocoding proxy — server key only.
 * Minimal port of legacy places.service.js (no geoip).
 */
import { env } from "../../config/env.js";
import { kv } from "../../redis/client.js";
import { AppError } from "../../utils/AppError.js";
import { logger } from "../../utils/logger.js";

const AUTOCOMPLETE_TTL = 12 * 60 * 60;
const DETAILS_TTL = 30 * 24 * 60 * 60;
const REVERSE_TTL = 7 * 24 * 60 * 60;

export type PlacePrediction = {
  placeId: string;
  description: string;
  mainText: string;
  secondaryText: string;
  types: string[];
};

export type PlaceDetails = {
  placeId: string;
  name: string;
  formattedAddress: string;
  lat?: number;
  lng?: number;
  houseNumber: string;
  street: string;
  locality?: string;
  city: string;
  state: string;
  country: string;
  countryCode: string;
  pincode: string;
  types: string[];
};

export type ReverseGeocodeResult = {
  placeId: string;
  formattedAddress: string;
  lat: number;
  lng: number;
  houseNumber: string;
  street: string;
  locality?: string;
  city: string;
  state: string;
  country: string;
  countryCode: string;
  pincode: string;
  types: string[];
};

function getServerKey(): string {
  return (env.GOOGLE_MAPS_SERVER_KEY || "").trim();
}

function requireKey(): string {
  const key = getServerKey();
  if (!key) {
    throw new AppError(503, "Google Maps is not configured", "MAPS_NOT_CONFIGURED");
  }
  return key;
}

function roundCoord(n: unknown, decimals = 5): number | null {
  const num = Number(n);
  if (!Number.isFinite(num)) return null;
  const f = 10 ** decimals;
  return Math.round(num * f) / f;
}

async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const raw = await kv.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function cacheSet(key: string, value: unknown, ttl: number): Promise<void> {
  try {
    await kv.set(key, JSON.stringify(value), ttl);
  } catch (err) {
    logger.warn("Places cache set failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

type GoogleJson = {
  status?: string;
  error_message?: string;
  predictions?: Array<Record<string, unknown>>;
  result?: Record<string, unknown>;
  results?: Array<Record<string, unknown>>;
};

async function googleGet(path: string, params: Record<string, string>): Promise<GoogleJson> {
  const key = requireKey();
  const url = new URL(`https://maps.googleapis.com/maps/api${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") {
      url.searchParams.set(k, v);
    }
  }
  url.searchParams.set("key", key);

  const response = await fetch(url.toString());
  const data = (await response.json().catch(() => ({}))) as GoogleJson;

  if (!response.ok) {
    throw new AppError(
      502,
      data.error_message || `Google Places HTTP ${response.status}`,
      "GOOGLE_PLACES_HTTP_ERROR",
    );
  }

  return data;
}

function mapPrediction(p: Record<string, unknown>): PlacePrediction {
  const structured = p.structured_formatting as
    { main_text?: string; secondary_text?: string } | undefined;
  const description = String(p.description || "");
  return {
    placeId: String(p.place_id || ""),
    description,
    mainText: structured?.main_text || description,
    secondaryText: structured?.secondary_text || "",
    types: Array.isArray(p.types) ? (p.types as string[]) : [],
  };
}

function parseAddressComponents(components: unknown[] = []) {
  let houseNumber = "";
  let street = "";
  let sublocality = "";
  let locality = "";
  let adminArea1 = "";
  let adminArea2 = "";
  let country = "";
  let countryCode = "";
  let pincode = "";

  for (const raw of components) {
    const c = raw as { types?: string[]; long_name?: string; short_name?: string };
    const t = c.types || [];
    if (t.includes("street_number")) houseNumber = c.long_name || "";
    if (t.includes("route")) street = c.long_name || "";
    if (
      !sublocality &&
      (t.includes("sublocality_level_1") || t.includes("sublocality") || t.includes("neighborhood"))
    ) {
      sublocality = c.long_name || "";
    }
    if (!locality && t.includes("locality")) locality = c.long_name || "";
    if (!adminArea2 && t.includes("administrative_area_level_2")) {
      adminArea2 = c.long_name || "";
    }
    if (!adminArea1 && t.includes("administrative_area_level_1")) {
      adminArea1 = c.long_name || "";
    }
    if (!country && t.includes("country")) {
      country = c.long_name || "";
      countryCode = (c.short_name || "").toUpperCase();
    }
    if (t.includes("postal_code")) pincode = c.long_name || "";
  }

  return {
    houseNumber,
    street,
    locality: sublocality || undefined,
    city: locality || adminArea2 || "",
    state: adminArea1,
    country,
    countryCode,
    pincode,
  };
}

export async function autocomplete(input: {
  q?: string;
  lat?: string | number;
  lng?: string | number;
  sessiontoken?: string;
  country?: string;
}): Promise<PlacePrediction[]> {
  const query = String(input.q || "").trim();
  if (query.length < 2) return [];

  const biasLat = roundCoord(input.lat);
  const biasLng = roundCoord(input.lng);
  const allowed = new Set(["us", "ca", "in"]);
  const cc = allowed.has(
    String(input.country || "")
      .trim()
      .toLowerCase(),
  )
    ? String(input.country).trim().toLowerCase()
    : "us";
  const cacheKey = `places:ac:${cc}:${query.toLowerCase()}:${biasLat ?? ""}:${biasLng ?? ""}`;

  const cached = await cacheGet<PlacePrediction[]>(cacheKey);
  if (cached) return cached;

  const params: Record<string, string> = {
    input: query,
    language: "en",
    components: `country:${cc}`,
  };
  if (input.sessiontoken) params.sessiontoken = String(input.sessiontoken);
  if (biasLat != null && biasLng != null) {
    params.location = `${biasLat},${biasLng}`;
    params.radius = "50000";
  }

  const data = await googleGet("/place/autocomplete/json", params);
  if (data.status === "ZERO_RESULTS") {
    await cacheSet(cacheKey, [], AUTOCOMPLETE_TTL);
    return [];
  }
  if (data.status !== "OK") {
    logger.warn("Places autocomplete non-OK", {
      status: data.status,
      error: data.error_message,
    });
    if (data.status === "REQUEST_DENIED" || data.status === "OVER_QUERY_LIMIT") {
      throw new AppError(
        503,
        data.error_message || data.status || "Places denied",
        "GOOGLE_PLACES_DENIED",
      );
    }
    return [];
  }

  const results = (data.predictions || []).map(mapPrediction);
  await cacheSet(cacheKey, results, AUTOCOMPLETE_TTL);
  return results;
}

export async function placeDetails(input: {
  placeId?: string;
  sessiontoken?: string;
}): Promise<PlaceDetails> {
  const id = String(input.placeId || "").trim();
  if (!id) {
    throw new AppError(400, "placeId is required", "VALIDATION_ERROR");
  }

  const cacheKey = `places:details:${id}`;
  const cached = await cacheGet<PlaceDetails>(cacheKey);
  if (cached) return cached;

  const params: Record<string, string> = {
    place_id: id,
    language: "en",
    fields: "geometry,formatted_address,name,address_components,place_id,types",
  };
  if (input.sessiontoken) params.sessiontoken = String(input.sessiontoken);

  const data = await googleGet("/place/details/json", params);
  if (data.status !== "OK" || !data.result) {
    throw new AppError(
      data.status === "NOT_FOUND" ? 404 : 502,
      data.error_message || "Place not found",
      data.status || "PLACE_NOT_FOUND",
    );
  }

  const place = data.result;
  const geometry = place.geometry as { location?: { lat?: number; lng?: number } } | undefined;
  const lat = geometry?.location?.lat;
  const lng = geometry?.location?.lng;
  const parsed = parseAddressComponents(
    Array.isArray(place.address_components) ? (place.address_components as unknown[]) : [],
  );

  const result: PlaceDetails = {
    placeId: String(place.place_id || id),
    name: String(place.name || ""),
    formattedAddress: String(place.formatted_address || ""),
    lat: typeof lat === "number" ? lat : undefined,
    lng: typeof lng === "number" ? lng : undefined,
    ...parsed,
    types: Array.isArray(place.types) ? (place.types as string[]) : [],
  };

  await cacheSet(cacheKey, result, DETAILS_TTL);
  return result;
}

export async function reverseGeocode(input: {
  lat?: string | number;
  lng?: string | number;
}): Promise<ReverseGeocodeResult> {
  const rLat = roundCoord(input.lat);
  const rLng = roundCoord(input.lng);
  if (rLat == null || rLng == null) {
    throw new AppError(400, "lat and lng are required", "VALIDATION_ERROR");
  }

  const cacheKey = `places:rev:${rLat}:${rLng}`;
  const cached = await cacheGet<ReverseGeocodeResult>(cacheKey);
  if (cached) return cached;

  let data = await googleGet("/geocode/json", {
    latlng: `${rLat},${rLng}`,
    language: "en",
    result_type: "street_address|route|neighborhood|sublocality|locality",
  });

  if (data.status === "ZERO_RESULTS" || !data.results?.[0]) {
    data = await googleGet("/geocode/json", {
      latlng: `${rLat},${rLng}`,
      language: "en",
    });
    if (data.status !== "OK" || !data.results?.[0]) {
      const empty: ReverseGeocodeResult = {
        placeId: "",
        formattedAddress: "",
        lat: rLat,
        lng: rLng,
        houseNumber: "",
        street: "",
        city: "",
        state: "",
        country: "",
        countryCode: "",
        pincode: "",
        types: [],
      };
      return empty;
    }
  }

  const place = data.results[0];
  const parsed = parseAddressComponents(
    Array.isArray(place.address_components) ? (place.address_components as unknown[]) : [],
  );
  const result: ReverseGeocodeResult = {
    placeId: String(place.place_id || ""),
    formattedAddress: String(place.formatted_address || ""),
    lat: rLat,
    lng: rLng,
    ...parsed,
    types: Array.isArray(place.types) ? (place.types as string[]) : [],
  };

  await cacheSet(cacheKey, result, REVERSE_TTL);
  return result;
}
