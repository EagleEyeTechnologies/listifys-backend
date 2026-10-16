const MAX_OFFER_AMOUNT = {
  INR: 50_000_000,
  USD: 1_000_000,
  CAD: 1_000_000,
} as const;

type OfferCurrency = keyof typeof MAX_OFFER_AMOUNT;

export function offerCurrency(raw?: string | null): OfferCurrency {
  const code = String(raw || "")
    .trim()
    .toUpperCase();
  if (code === "INR" || code === "₹" || code === "RS") return "INR";
  if (code === "CAD" || code === "C$" || code === "CUSD") return "CAD";
  return "USD";
}

export function maxOfferAmount(currency?: string | null) {
  return MAX_OFFER_AMOUNT[offerCurrency(currency)];
}

export function offerLimitLabel(currency?: string | null) {
  const code = offerCurrency(currency);
  const amount = MAX_OFFER_AMOUNT[code];
  const locale = code === "INR" ? "en-IN" : code === "CAD" ? "en-CA" : "en-US";
  const symbol = code === "INR" ? "₹" : code === "CAD" ? "C$" : "$";
  return `${symbol}${amount.toLocaleString(locale)}`;
}
