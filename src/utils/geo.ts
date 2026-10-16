/** Haversine distance in miles between two WGS84 points. */
export function distanceMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 3958.8;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** [0, 0] is what broken geocoders send; it is never a real listing location. */
export function isUsablePoint(lat: unknown, lng: unknown): boolean {
  return (
    typeof lat === "number" &&
    typeof lng === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    !(lat === 0 && lng === 0)
  );
}

/**
 * Case-, space- and punctuation-insensitive matcher for a place name, so
 * "Pedda Papaiah Pally" also finds "Peddapapaiahpally" and "Hitech" finds "HITEC".
 */
export function placeNameRegex(name: string): RegExp | null {
  const compact = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (compact.length < 2) return null;
  const variants = new Set([compact]);
  if (compact.includes("hitech")) variants.add(compact.replace("hitech", "hitec"));
  else if (compact.includes("hitec")) variants.add(compact.replace("hitec", "hitech"));
  const source = [...variants].map((v) => v.split("").join("[^a-z0-9]*")).join("|");
  return new RegExp(source, "i");
}
