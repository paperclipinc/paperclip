// Instance-level DISPLAY currency for monetary amounts. The server injects a
// `paperclip-display-currency` meta tag when PAPERCLIP_DISPLAY_CURRENCY is set
// to a non-USD code (see server/src/ui-branding.ts); the unconfigured default
// build carries no meta and renders USD exactly as before. Display-only:
// stored cent amounts are never converted.

const DEFAULT_DISPLAY_CURRENCY = "USD";

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  EUR: "€",
};

const CURRENCY_AMOUNT_NOUNS: Record<string, string> = {
  USD: "dollar amount",
  EUR: "euro amount",
};

export function resolveDisplayCurrency(raw: string | null | undefined): string {
  const normalized = raw?.trim().toUpperCase();
  return normalized && /^[A-Z]{3}$/.test(normalized) ? normalized : DEFAULT_DISPLAY_CURRENCY;
}

function readMetaContent(name: string): string | null {
  if (typeof document === "undefined") return null;
  const element = document.querySelector(`meta[name="${name}"]`);
  const content = element?.getAttribute("content")?.trim();
  return content ? content : null;
}

// The meta tag never changes within a page load, so read it once and cache.
let cached: string | null = null;

export function getDisplayCurrency(): string {
  if (cached === null) {
    cached = resolveDisplayCurrency(readMetaContent("paperclip-display-currency"));
  }
  return cached;
}

/** Prefix used by formatCents: "$"/"€" for known codes, "XXX " otherwise. */
export function currencySymbol(code: string = getDisplayCurrency()): string {
  return CURRENCY_SYMBOLS[code] ?? `${code} `;
}

/** Copy noun for amount-input validation ("dollar amount", "euro amount", ...). */
export function currencyAmountNoun(code: string = getDisplayCurrency()): string {
  return CURRENCY_AMOUNT_NOUNS[code] ?? "amount";
}

export function resetDisplayCurrencyForTests(): void {
  cached = null;
}
