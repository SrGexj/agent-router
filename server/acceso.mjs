// Acceso protegido por token para exponer el dashboard por un túnel (Cloudflare). Lógica pura: sin E/S ni reloj.
import { timingSafeEqual } from "node:crypto";

export const COOKIE_NAME = "router_token";
export const MIN_TOKEN_LENGTH = 32;
export const COOKIE_MAX_AGE = 2592000; // 30 días
export const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/;

// Comparación en tiempo constante; longitudes distintas → false sin lanzar.
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// Solo es acceso local el que llega con Host local y sin rastro de proxy/túnel.
export function isLocalAccess(headers) {
  return LOCAL_HOST.test(headers.host ?? "") && headers["cf-connecting-ip"] === undefined && headers["x-forwarded-for"] === undefined;
}

function cookieValue(header, name) {
  for (const part of String(header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

// req: { method, url, headers }. method "UPGRADE" = apretón de WebSocket (sin token por URL ni redirect).
// Devuelve { action: "allow" } | { action: "deny" } | { action: "redirect", cookie, location }.
export function decideAccess({ method, url, headers }, token) {
  if (!token) return { action: "allow" };
  if (isLocalAccess(headers)) return { action: "allow" };
  if (safeEqual(cookieValue(headers.cookie, COOKIE_NAME), token)) return { action: "allow" };
  if (method === "GET") {
    const u = new URL(url, "http://x");
    if (safeEqual(u.searchParams.get("token"), token)) {
      u.searchParams.delete("token");
      const path = u.pathname.replace(/^\/+/, "/"); // nunca "//host": evita redirect abierto
      return {
        action: "redirect",
        cookie: `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE}`,
        location: path + u.search
      };
    }
  }
  return { action: "deny" };
}

export function accessMiddleware(token) {
  return (req, res, next) => {
    const d = decideAccess({ method: req.method, url: req.originalUrl, headers: req.headers }, token);
    if (d.action === "allow") return next();
    if (d.action === "redirect") {
      res.setHeader("Set-Cookie", d.cookie);
      return res.redirect(302, d.location);
    }
    res.status(401).type("text/plain").send("No autorizado");
  };
}
