// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  currencyAmountNoun,
  currencySymbol,
  getDisplayCurrency,
  resetDisplayCurrencyForTests,
  resolveDisplayCurrency,
} from "./display-currency";
import { formatCents } from "./utils";

function setCurrencyMeta(content: string | null) {
  document.querySelector('meta[name="paperclip-display-currency"]')?.remove();
  if (content !== null) {
    const meta = document.createElement("meta");
    meta.setAttribute("name", "paperclip-display-currency");
    meta.setAttribute("content", content);
    document.head.appendChild(meta);
  }
  resetDisplayCurrencyForTests();
}

afterEach(() => {
  setCurrencyMeta(null);
});

describe("resolveDisplayCurrency", () => {
  it("defaults to USD", () => {
    expect(resolveDisplayCurrency(null)).toBe("USD");
    expect(resolveDisplayCurrency(undefined)).toBe("USD");
    expect(resolveDisplayCurrency("")).toBe("USD");
  });

  it("accepts a 3-letter ISO code and normalizes case", () => {
    expect(resolveDisplayCurrency("EUR")).toBe("EUR");
    expect(resolveDisplayCurrency("eur")).toBe("EUR");
    expect(resolveDisplayCurrency(" chf ")).toBe("CHF");
  });

  it("rejects malformed codes and falls back to USD", () => {
    expect(resolveDisplayCurrency("EU")).toBe("USD");
    expect(resolveDisplayCurrency("EURO")).toBe("USD");
    expect(resolveDisplayCurrency("12$")).toBe("USD");
  });
});

describe("getDisplayCurrency", () => {
  it("is USD when the instance sets no display-currency meta", () => {
    setCurrencyMeta(null);
    expect(getDisplayCurrency()).toBe("USD");
  });

  it("reads the instance display-currency meta tag", () => {
    setCurrencyMeta("EUR");
    expect(getDisplayCurrency()).toBe("EUR");
  });

  it("falls back to USD for a malformed meta value", () => {
    setCurrencyMeta("not-a-code");
    expect(getDisplayCurrency()).toBe("USD");
  });
});

describe("currencySymbol", () => {
  it("maps known currencies to their symbol", () => {
    expect(currencySymbol("USD")).toBe("$");
    expect(currencySymbol("EUR")).toBe("€");
  });

  it("falls back to a code prefix for unmapped currencies", () => {
    expect(currencySymbol("CHF")).toBe("CHF ");
  });
});

describe("currencyAmountNoun", () => {
  it("names the amount after the display currency", () => {
    expect(currencyAmountNoun("USD")).toBe("dollar amount");
    expect(currencyAmountNoun("EUR")).toBe("euro amount");
    expect(currencyAmountNoun("CHF")).toBe("amount");
  });
});

describe("formatCents", () => {
  it("stays byte-identical for the USD default", () => {
    setCurrencyMeta(null);
    expect(formatCents(123456)).toBe("$1,234.56");
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(-500)).toBe("$-5.00");
  });

  it("formats with the instance display currency", () => {
    setCurrencyMeta("EUR");
    expect(formatCents(100)).toBe("€1.00");
    expect(formatCents(42)).toBe("€0.42");
  });

  it("prefixes unmapped currencies with their code", () => {
    setCurrencyMeta("CHF");
    expect(formatCents(100)).toBe("CHF 1.00");
  });
});
