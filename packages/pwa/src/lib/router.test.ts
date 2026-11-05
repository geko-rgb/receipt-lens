import { describe, expect, it } from "vitest";
import { fragmentOf, resolveLocation, routeFor, targetUrl, ROUTE_PATHS } from "./router.js";

/**
 * These are the DECISIONS/0017 D3a rules as pure arithmetic on strings, so the opacity guarantees are
 * checked in Node without a browser. The live `hashchange`/`popstate` behaviour, which needs a real
 * history object, is checked in playwright/shell.spec.ts.
 */

describe("fragmentOf — the fragment is opaque", () => {
  it("strips only the leading #", () => {
    expect(fragmentOf("#v1.token.nonce.ciphertext")).toBe("v1.token.nonce.ciphertext");
    expect(fragmentOf("v1.token.nonce.ciphertext")).toBe("v1.token.nonce.ciphertext");
    expect(fragmentOf("")).toBe("");
    expect(fragmentOf("#")).toBe("");
  });

  it("never splits on a later #", () => {
    expect(fragmentOf("#v1.abc#def")).toBe("v1.abc#def");
    expect(fragmentOf("##")).toBe("#");
  });

  it("never URL-decodes, because decoding belongs to ticket 16's codec", () => {
    expect(fragmentOf("#v1.a%2Fb%3D")).toBe("v1.a%2Fb%3D");
    expect(fragmentOf("#v1.a+b")).toBe("v1.a+b");
    expect(fragmentOf("#v1.-_~.A")).toBe("v1.-_~.A");
  });
});

describe("routeFor — the pinned fallback", () => {
  it("serves the known paths", () => {
    expect(routeFor("/", "")).toBe("capture");
    expect(routeFor(ROUTE_PATHS.capture, "")).toBe("capture");
    expect(routeFor(ROUTE_PATHS.bill, "")).toBe("bill");
    // DECISIONS/0023 P7: the ledger is a route of its own.
    expect(routeFor(ROUTE_PATHS.bills, "")).toBe("bills");
    expect(routeFor(ROUTE_PATHS.share, "")).toBe("share");
  });

  it("routes a fragment-bearing landing page to share — the primary share-link entry point", () => {
    expect(routeFor("/", "v1.token.nonce.ciphertext")).toBe("share");
  });

  it("keeps a fragment on its own path's view", () => {
    expect(routeFor(ROUTE_PATHS.bill, "v1.token.nonce.ciphertext")).toBe("bill");
    expect(routeFor(ROUTE_PATHS.bills, "v1.token.nonce.ciphertext")).toBe("bills");
    expect(routeFor(ROUTE_PATHS.capture, "v1.token.nonce.ciphertext")).toBe("capture");
  });

  it("shows not-found for an unknown path, with or without a fragment", () => {
    expect(routeFor("/nonexistent", "")).toBe("notFound");
    expect(routeFor("/nonexistent", "v1.token")).toBe("notFound");
    expect(routeFor("/BILL", "v1.token")).toBe("notFound");
  });
});

describe("targetUrl — navigation must not re-encode the fragment", () => {
  it("concatenates rather than building a URL", () => {
    expect(targetUrl(ROUTE_PATHS.bill, "v1.abc")).toBe("/bill#v1.abc");
    expect(targetUrl(ROUTE_PATHS.bills, "v1.abc")).toBe("/bills#v1.abc");
    expect(targetUrl(ROUTE_PATHS.bill, "")).toBe("/bill");
  });

  it("leaves percent, plus, tilde and inner # bytes untouched", () => {
    expect(targetUrl("/bill", "v1.a%2Fb+c~d#e")).toBe("/bill#v1.a%2Fb+c~d#e");
  });

  it("preserves a fragment byte-for-byte across a chain of navigations", () => {
    // The browser's own hash semantics, restated for a bare string: everything from the first "#".
    // A path can never contain "#", so this is what location.hash would report.
    const hashOf = (url: string): string => {
      const index = url.indexOf("#");
      return index === -1 ? "" : url.slice(index);
    };
    const fragment = "v1." + "A".repeat(200) + "-" + "_z9";
    let url = targetUrl(ROUTE_PATHS.capture, fragment);
    for (const path of [ROUTE_PATHS.bill, ROUTE_PATHS.share]) {
      url = targetUrl(path, fragmentOf(hashOf(url)));
    }
    expect(url).toBe("/share#" + fragment);
    expect(fragmentOf(hashOf(url))).toBe(fragment);
  });
});

describe("resolveLocation", () => {
  it("pairs the view with the raw fragment", () => {
    expect(resolveLocation({ pathname: "/", hash: "#v1.x#y" })).toEqual({ route: "share", fragment: "v1.x#y" });
    expect(resolveLocation({ pathname: "/bill", hash: "" })).toEqual({ route: "bill", fragment: "" });
  });
});
