// Headless VidFast resolver for Cloudflare/Vercel Workers
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
  
  // HLS stream URL നിർമ്മിക്കാൻ/എക്സ്ട്രാക്ട് ചെയ്യാനുള്ള ഭാഗം
  let streamUrl = "";
  if (props && props.en) {
    // VidFast പ്ലെയർ ടോക്കൺ ഉപയോഗിച്ച് HLS സോഴ്സ് ജനറേറ്റ് ചെയ്യുന്ന എൻഡ്പോയിന്റ് റിക്വസ്റ്റ്
    try {
      const sourceApi = `https://vidfast.vc/api/source/${props.en}`;
      const res = await nativeFetch(sourceApi, {
        headers: mergedHeaders({
          "accept": "application/json, text/javascript, */*; q=0.01",
          "x-requested-with": "XMLHttpRequest"
        })
      });
      if (res.ok) {
        const data = await res.json();
        streamUrl = data.url || data.file || "";
      }
    } catch (err) {
      log("Source API fetch error:", err.message);
    }
  }

  // ഒരുവട്ടം കൂടി പേജിൽ നിന്ന് .m3u8 ലിങ്ക് നേരിട്ട് തപ്പുക
  if (!streamUrl) {
    const m3u8Match = html.match(/(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/i);
    if (m3u8Match) {
      streamUrl = m3u8Match[1];
    }
  }

  return {
    url: streamUrl || pageUrl,
    props,
    server: "VidFast Worker",
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/") {
      return new Response(JSON.stringify({ 
        status: "VidFast Worker is Running!", 
        supported_routes: ["/movie/<id>", "/tv/<id>/<season>/<episode>"] 
      }), {
        headers: { "Content-Type": "application/json" }
      });
    }

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
