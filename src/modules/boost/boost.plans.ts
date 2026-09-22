import type { CountryCode } from "../../types/domain.js";

export type BoostPlanDto = {
  planKey: string;
  days: number;
  label: string;
  description: string;
  popular: boolean;
  countryCode: CountryCode;
  currency: "INR" | "USD" | "CAD";
  currencySymbol: string;
  amountMinor: number;
  taxRate: number;
  taxMinor: number;
  totalMinor: number;
};

const TAX: Record<CountryCode, number> = {
  IN: 0.18,
  US: 0,
  CA: 0,
};

const CATALOG = [
  {
    planKey: "3d",
    days: 3,
    label: "3-Day Boost",
    description: "Short visibility boost for quick sales",
    popular: false,
    amounts: { IN: 14900, US: 199, CA: 249 },
  },
  {
    planKey: "7d",
    days: 7,
    label: "7-Day Boost",
    description: "Best balance of reach and value",
    popular: true,
    amounts: { IN: 29900, US: 399, CA: 499 },
  },
  {
    planKey: "15d",
    days: 15,
    label: "15-Day Boost",
    description: "Maximum fixed-duration visibility",
    popular: false,
    amounts: { IN: 49900, US: 699, CA: 899 },
  },
] as const;

function moneyMeta(country: CountryCode) {
  if (country === "IN") return { currency: "INR" as const, currencySymbol: "₹" };
  if (country === "CA") return { currency: "CAD" as const, currencySymbol: "C$" };
  return { currency: "USD" as const, currencySymbol: "$" };
}

export function listBoostPlans(countryCode: CountryCode): BoostPlanDto[] {
  const taxRate = TAX[countryCode] ?? 0;
  const meta = moneyMeta(countryCode);
  return CATALOG.map((p) => {
    const amountMinor = p.amounts[countryCode];
    const taxMinor = Math.round(amountMinor * taxRate);
    return {
      planKey: p.planKey,
      days: p.days,
      label: p.label,
      description: p.description,
      popular: p.popular,
      countryCode,
      currency: meta.currency,
      currencySymbol: meta.currencySymbol,
      amountMinor,
      taxRate,
      taxMinor,
      totalMinor: amountMinor + taxMinor,
    };
  });
}

export function getBoostPlan(planKey: string, countryCode: CountryCode): BoostPlanDto | null {
  return listBoostPlans(countryCode).find((p) => p.planKey === planKey) || null;
}

export function formatMinor(amountMinor: number, currency: string) {
  return new Intl.NumberFormat(
    currency === "INR" ? "en-IN" : currency === "CAD" ? "en-CA" : "en-US",
    { style: "currency", currency, maximumFractionDigits: 2 },
  ).format(amountMinor / 100);
}
