// Hash routes, so pages deep-link and browser back/forward work without a router dependency.
//   #store            demo storefront          #setup        onboarding
//   #/<slug>          merchant page            #/case/<id>   case investigation
//   #/orders/<id>     order detail             #/orders?status=<filter>&q=<query>
import { NAV_ITEMS, type NavId } from "./system-truth.ts";

export type Route =
  | { surface: "store" }
  | { surface: "setup" }
  | { surface: "merchant"; nav: NavId; caseId?: string; orderId?: string; params?: Record<string, string> };

export function parseRoute(hash: string): Route | null {
  if (hash === "#store") return { surface: "store" };
  if (hash === "#setup") return { surface: "setup" };
  const m = /^#\/([^?]*)(?:\?(.*))?$/.exec(hash);
  if (!m) return null;
  const [slug, id] = m[1].split("/").map(decodeURIComponent);
  const params = Object.fromEntries(new URLSearchParams(m[2] ?? ""));
  if (slug === "case" && id) return { surface: "merchant", nav: "cases", caseId: id };
  const item = NAV_ITEMS.find((n) => n.slug === slug);
  if (!item) return null;
  return {
    surface: "merchant",
    nav: item.id,
    ...(item.id === "orders" && id ? { orderId: id } : {}),
    ...(Object.keys(params).length ? { params } : {}),
  };
}

export function formatRoute(r: Route): string {
  if (r.surface === "store") return "#store";
  if (r.surface === "setup") return "#setup";
  if (r.caseId) return `#/case/${encodeURIComponent(r.caseId)}`;
  const slug = NAV_ITEMS.find((n) => n.id === r.nav)!.slug;
  const q = r.params && Object.keys(r.params).length ? `?${new URLSearchParams(r.params).toString()}` : "";
  return `#/${slug}${r.orderId ? `/${encodeURIComponent(r.orderId)}` : ""}${q}`;
}
