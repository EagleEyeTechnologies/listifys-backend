import type { CountryCode } from "../../types/domain.js";

export type PremiumPlanDto = {
  planKey: "monthly";
  days: number;
  trialDays: number;
  label: string;
  description: string;
  freeBoostsPerMonth: number;
  perks: Array<{ key: string; title: string; body: string }>;
  countryCode: CountryCode;
  currency: "INR" | "USD" | "CAD";
  currencySymbol: string;
  amountMinor: number;
  taxRate: number;
  taxMinor: number;
  totalMinor: number;
};

const TAX: Record<CountryCode, number> = { IN: 0.18, US: 0, CA: 0 };

const BASE = {
  planKey: "monthly" as const,
  days: 30,
  trialDays: 7,
  label: "Seller Premium",
  description:
    "Monthly membership with free boosts and a Premium seller badge",
  freeBoostsPerMonth: 3,
  perks: [
    {
      key: "free_boosts",
      title: "3 free boosts / month",
      body: "Apply included boosts to any listing without paying à la carte.",
    },
    {
      key: "badge",
      title: "Premium seller badge",
      body: "Stand out on your profile and listings.",
    },
    {
      key: "priority",
      title: "Feed priority",
      body: "Slight ranking boost across discovery surfaces.",
    },
    {
      key: "insights",
      title: "Boost insights",
      body: "Campaign performance stays available in your boost dashboard.",
    },
  ],
  amounts: { IN: 49900, US: 599, CA: 799 } as Record<CountryCode, number>,
};

function moneyMeta(country: CountryCode) {
  if (country === "IN") return { currency: "INR" as const, currencySymbol: "₹" };
  if (country === "CA") return { currency: "CAD" as const, currencySymbol: "C$" };
  return { currency: "USD" as const, currencySymbol: "$" };
}

export function getPremiumPlan(countryCode: CountryCode): PremiumPlanDto {
  const taxRate = TAX[countryCode] ?? 0;
  const meta = moneyMeta(countryCode);
  const amountMinor = BASE.amounts[countryCode];
  const taxMinor = Math.round(amountMinor * taxRate);
  return {
    planKey: BASE.planKey,
    days: BASE.days,
    trialDays: BASE.trialDays,
    label: BASE.label,
    description: BASE.description,
    freeBoostsPerMonth: BASE.freeBoostsPerMonth,
    perks: BASE.perks,
    countryCode,
    currency: meta.currency,
    currencySymbol: meta.currencySymbol,
    amountMinor,
    taxRate,
    taxMinor,
    totalMinor: amountMinor + taxMinor,
  };
}

export function formatPremiumMinor(amountMinor: number, currency: string) {
  return new Intl.NumberFormat(
    currency === "INR" ? "en-IN" : currency === "CAD" ? "en-CA" : "en-US",
    { style: "currency", currency, maximumFractionDigits: 2 },
  ).format(amountMinor / 100);
}
