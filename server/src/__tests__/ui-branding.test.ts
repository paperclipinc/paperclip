import { describe, expect, it } from "vitest";
import {
  applyUiBranding,
  getBrandDir,
  getWorktreeUiBranding,
  isWorktreeUiBrandingEnabled,
  renderBrandStylesheetLink,
  renderFaviconLinks,
  renderRuntimeBrandingMeta,
} from "../ui-branding.js";

const TEMPLATE = `<!doctype html>
<head>
    <!-- PAPERCLIP_RUNTIME_BRANDING_START -->
    <!-- PAPERCLIP_RUNTIME_BRANDING_END -->
    <!-- PAPERCLIP_FAVICON_START -->
    <link rel="icon" href="/favicon.ico" sizes="48x48" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
    <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
    <!-- PAPERCLIP_FAVICON_END -->
</head>`;

describe("ui branding", () => {
  it("detects worktree mode from PAPERCLIP_IN_WORKTREE", () => {
    expect(isWorktreeUiBrandingEnabled({ PAPERCLIP_IN_WORKTREE: "true" })).toBe(true);
    expect(isWorktreeUiBrandingEnabled({ PAPERCLIP_IN_WORKTREE: "1" })).toBe(true);
    expect(isWorktreeUiBrandingEnabled({ PAPERCLIP_IN_WORKTREE: "false" })).toBe(false);
  });

  it("resolves name, color, and text color for worktree branding", () => {
    const branding = getWorktreeUiBranding({
      PAPERCLIP_IN_WORKTREE: "true",
      PAPERCLIP_WORKTREE_NAME: "paperclip-pr-432",
      PAPERCLIP_WORKTREE_COLOR: "#4f86f7",
    });

    expect(branding.enabled).toBe(true);
    expect(branding.name).toBe("paperclip-pr-432");
    expect(branding.color).toBe("#4f86f7");
    expect(branding.textColor).toMatch(/^#[0-9a-f]{6}$/);
    expect(branding.faviconHref).toContain("data:image/svg+xml,");
  });

  it("renders a dynamic worktree favicon when enabled", () => {
    const links = renderFaviconLinks(
      getWorktreeUiBranding({
        PAPERCLIP_IN_WORKTREE: "true",
        PAPERCLIP_WORKTREE_NAME: "paperclip-pr-432",
        PAPERCLIP_WORKTREE_COLOR: "#4f86f7",
      }),
    );
    expect(links).toContain("data:image/svg+xml,");
    expect(links).toContain('rel="shortcut icon"');
  });

  it("renders runtime branding metadata for the ui", () => {
    const meta = renderRuntimeBrandingMeta(
      getWorktreeUiBranding({
        PAPERCLIP_IN_WORKTREE: "true",
        PAPERCLIP_WORKTREE_NAME: "paperclip-pr-432",
        PAPERCLIP_WORKTREE_COLOR: "#4f86f7",
      }),
    );
    expect(meta).toContain('name="paperclip-worktree-name"');
    expect(meta).toContain('content="paperclip-pr-432"');
    expect(meta).toContain('name="paperclip-worktree-color"');
  });

  it("rewrites the favicon and runtime branding blocks for worktree instances only", () => {
    const branded = applyUiBranding(TEMPLATE, {
      PAPERCLIP_IN_WORKTREE: "true",
      PAPERCLIP_WORKTREE_NAME: "paperclip-pr-432",
      PAPERCLIP_WORKTREE_COLOR: "#4f86f7",
    });
    expect(branded).toContain("data:image/svg+xml,");
    expect(branded).toContain('name="paperclip-worktree-name"');
    expect(branded).not.toContain('href="/favicon.svg"');

    const defaultHtml = applyUiBranding(TEMPLATE, {});
    expect(defaultHtml).toContain('href="/favicon.svg"');
    expect(defaultHtml).not.toContain('name="paperclip-worktree-name"');
  });

  it("resolves the brand directory only when PAPERCLIP_BRAND_DIR is set", () => {
    expect(getBrandDir({})).toBeNull();
    expect(getBrandDir({ PAPERCLIP_BRAND_DIR: "  " })).toBeNull();
    expect(getBrandDir({ PAPERCLIP_BRAND_DIR: "/etc/paperclip/branding" })).toBe(
      "/etc/paperclip/branding",
    );
  });

  it("emits the brand stylesheet link only when a brand dir is configured", () => {
    expect(renderBrandStylesheetLink({})).toBe("");
    const link = renderBrandStylesheetLink({ PAPERCLIP_BRAND_DIR: "/etc/paperclip/branding" });
    expect(link).toBe('<link rel="stylesheet" href="/branding/brand.css" />');
  });

  it("injects the brand stylesheet just before </head> so it wins the cascade", () => {
    const template = `<!doctype html>
<head>
    <!-- PAPERCLIP_RUNTIME_BRANDING_START -->
    <!-- PAPERCLIP_RUNTIME_BRANDING_END -->
    <!-- PAPERCLIP_FAVICON_START -->
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <!-- PAPERCLIP_FAVICON_END -->
    <link rel="stylesheet" crossorigin href="/assets/index-abc.css">
  </head>`;
    const branded = applyUiBranding(template, { PAPERCLIP_BRAND_DIR: "/etc/paperclip/branding" });
    expect(branded).toContain('<link rel="stylesheet" href="/branding/brand.css" />');
    // Brand link must come AFTER the bundled stylesheet so its var overrides win.
    expect(branded.indexOf("/branding/brand.css")).toBeGreaterThan(
      branded.indexOf("/assets/index-abc.css"),
    );
    // And it must sit inside <head>.
    expect(branded.indexOf("/branding/brand.css")).toBeLessThan(branded.indexOf("</head>"));
  });

  it("does not inject a brand stylesheet when the brand dir is unset", () => {
    const branded = applyUiBranding(TEMPLATE, {});
    expect(branded).not.toContain("/branding/brand.css");
  });
});
