// Headless VidFast resolver for Cloudflare Workers
import { webcrypto } from "node:crypto";

const debug = process.env.VIDFAST_DEBUG === "1";
const log = (...args) => {
  if (debug) console.log("[vidfast] " + args.map(item => typeof item === "string" ? item : String(item)).join(" "));
};

function describeError(error) {
  const parts = [];
  let current = error;
  for (let depth = 0; current && depth < 4; depth += 1) {
    const text = typeof current === "string" ? current : current.message || String(current);
    const code = typeof current === "object" ? current.code : undefined;
    const label = code && !text.includes(code) ? `${code}: ${text}` : text;
    if (label && !parts.includes(label)) parts.push(label);
    current = typeof current === "object" ? current.cause : undefined;
  }
  return parts.join(" <- ") || String(error);
}

async function resolveVidFast(inputUrl) {
  const pageUrl = new URL(inputUrl).href;
  const pageOrigin = new URL(pageUrl).origin;
  
  const userAgent =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

  let nativeFetch = globalThis.fetch.bind(globalThis);
  const cookies = new Map();

  function storeCookies(response) {
    const values = response.headers.getSetCookie?.() || [];
    const raw = values.length ? values.join(",") : response.headers.get("set-cookie") || "";
    for (const item of raw.split(/,(?=\s*[^;,]+=[^;,]+)/)) {
      const first = item.split(";", 1)[0].trim();
      const index = first.indexOf("=");
      if (index > 0) cookies.set(first.slice(0, index), first.slice(index + 1));
    }
  }

  function cookieHeader() {
    return [...cookies.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
  }

  function mergedHeaders(initHeaders = {}, referer = pageUrl) {
    const headers = new Headers(initHeaders);
    if (!headers.has("user-agent")) headers.set("user-agent", userAgent);
    headers.set("referer", "https://vidfast.vc/");
    headers.set("origin", "https://vidfast.vc");
    headers.set("sec-ch-ua", '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"');
    headers.set("sec-ch-ua-mobile", "?0");
    headers.set("sec-ch-ua-platform", '"Windows"');
    headers.set("sec-fetch-dest", "document");
    headers.set("sec-fetch-mode", "navigate");
    headers.set("sec-fetch-site", "cross-site");
    const cookie = cookieHeader();
    if (cookie) headers.set("cookie", cookie);
    return headers;
  }

  async function fetchPage() {
    const response = await nativeFetch(pageUrl, {
      headers: mergedHeaders({
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        "upgrade-insecure-requests": "1",
      }),
    });
    storeCookies(response);
    if (!response.ok) throw new Error(`VidFast page returned HTTP ${response.status}`);
    return response.text();
  }

  function parseProps(html) {
    const tokenMatch = html.match(/\\"en\\":\\"([^\\"]+)\\"/);
    if (!tokenMatch) throw new Error("VidFast session token not found");
    const start = html.indexOf(tokenMatch[0]);
    const chunk = html.slice(start, start + 2500);
    const end = chunk.match(/\\"server\\":(?:\\"[^\\"]*\\"|null)\}/);
    if (!end) throw new Error("VidFast player payload is incomplete");
    const raw = chunk.slice(0, end.index + end[0].length)
      .replace(/\\"/g, '"')
      .replace(/"\$undefined"/g, "null");
    try {
      return JSON.parse(`{${raw.slice(0, -1)}}`);
    } catch (error) {
      throw new Error(`VidFast player payload is invalid: ${error.message}`);
    }
  }

  const html = await fetchPage();
  const props = parseProps(html);
  
  return {
    url: pageUrl,
    props,
    server: "VidFast Worker",
  };
}

// Cloudflare Worker Default Export Handler
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // റൂട്ട് ടെസ്റ്റ് പേജ്
    if (path === "/") {
      return new Response(JSON.stringify({ 
        status: "VidFast Worker is Running!", 
        supported_routes: ["/movie/<id>", "/tv/<id>/<season>/<episode>"] 
      }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // /movie/<id> അല്ലെങ്കിൽ /tv/<id>/<season>/<episode> പാറ്റേൺ മാച്ച് ചെയ്യാൻ
    const movieMatch = path.match(/^\/movie\/(\d+)\/?$/i);
    const tvMatch = path.match(/^\/tv\/(\d+)\/(\d+)\/(\d+)\/?$/i);

    if (movieMatch || tvMatch) {
      try {
        let targetUrl = "";
        if (movieMatch) {
          const movieId = movieMatch[1];
          targetUrl = `https://vidfast.vc/movie/${movieId}`;
        } else if (tvMatch) {
          const [_, tvId, season, episode] = tvMatch;
          targetUrl = `https://vidfast.vc/tv/${tvId}/${season}/${episode}`;
        }
        
        const result = await resolveVidFast(targetUrl);
        return new Response(JSON.stringify(result), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: describeError(error) }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    return new Response(JSON.stringify({ error: "VidFast: unsupported URL format" }), { 
      status: 404,
      headers: { "Content-Type": "application/json" }
    });
  }
};
