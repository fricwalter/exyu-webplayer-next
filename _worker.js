const DEFAULT_CORS_ORIGIN = "*";

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }), env);
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === "/player_api.php") {
        const response = await handlePlayerApi(request, env);
        return withCors(response, env);
      }

      if (isMediaPath(url.pathname)) {
        const response = await handleMediaProxy(request, env, url);
        return withCors(response, env);
      }

      if (url.pathname === "/health") {
        return withCors(jsonResponse({ ok: true, service: "webplayer-next" }), env);
      }

      if (env.ASSETS && typeof env.ASSETS.fetch === "function") {
        const assetResponse = await env.ASSETS.fetch(request);
        return withCors(withNoStoreAsset(assetResponse), env);
      }

      return withCors(new Response("Not Found", { status: 404 }), env);
    } catch (error) {
      return withCors(errorToResponse(error), env);
    }
  },
};

async function handlePlayerApi(request, env) {
  const upstreamBases = getUpstreamBases(env);
  const params = await requestToParams(request.clone());

  const upstreamResponse = await fetchWithFailover(upstreamBases, (base) => {
    const target = new URL("player_api.php", base);
    target.search = params.toString();
    return fetch(target.toString(), {
      method: "GET",
      headers: { accept: "application/json,text/plain,*/*" },
      redirect: "manual",
      signal: request.signal,
    });
  });

  return proxyResponse(upstreamResponse);
}

function isMediaPath(pathname) {
  return /^\/(live|movie|series|timeshift|streaming|hls)\//i.test(pathname);
}

async function handleMediaProxy(request, env, url) {
  const preferredUpstream = url.searchParams.get("_up") || "";
  const upstreamBases = getPreferredUpstreamBases(env, preferredUpstream);
  const method = request.method || "GET";
  const bodyAllowed = method !== "GET" && method !== "HEAD";

  const upstreamResponse = await fetchWithFailover(upstreamBases, (base) => {
    const target = buildUpstreamMediaUrl(base, url);
    return fetch(target.toString(), {
      method,
      headers: buildForwardHeaders(request.headers, {
        forceUserAgent: getMediaUserAgent(env),
      }),
      body: bodyAllowed ? request.body : undefined,
      redirect: "follow",
      signal: request.signal,
    });
  });

  const headers = new Headers();
  const passHeaders = [
    "content-type",
    "content-length",
    "accept-ranges",
    "content-range",
    "cache-control",
    "etag",
    "last-modified",
    "content-disposition",
  ];

  for (const name of passHeaders) {
    const value = upstreamResponse.headers.get(name);
    if (value) {
      headers.set(name, value);
    }
  }

  if (!headers.has("cache-control")) {
    headers.set("cache-control", "no-store");
  }

  if (shouldRewriteHlsManifest(url, upstreamResponse)) {
    const manifest = await upstreamResponse.text();
    const rewritten = rewriteHlsManifest(manifest, request.url, upstreamResponse.url);
    headers.set("content-type", "application/x-mpegurl");
    headers.delete("content-length");
    return new Response(rewritten, { status: upstreamResponse.status, headers });
  }

  return new Response(upstreamResponse.body, { status: upstreamResponse.status, headers });
}

function getMediaUserAgent(env) {
  const configured = String(env.MEDIA_USER_AGENT || "").trim();
  return configured || "VLC/3.0.9 LibVLC/3.0.9";
}

function buildForwardHeaders(source, { forceUserAgent = "" } = {}) {
  const headers = new Headers();
  const allowed = [
    "accept",
    "accept-language",
    "if-none-match",
    "if-modified-since",
    "referer",
    "origin",
    "authorization",
    "range",
  ];

  for (const key of allowed) {
    const value = source.get(key);
    if (value) {
      headers.set(key, value);
    }
  }

  headers.set("user-agent", forceUserAgent || "StreamityProxyWorker/1.0");
  return headers;
}

function buildUpstreamMediaUrl(base, requestUrl) {
  const outbound = new URL(requestUrl.pathname + requestUrl.search, base);
  outbound.searchParams.delete("_up");
  return outbound;
}

function shouldRewriteHlsManifest(requestUrl, upstreamResponse) {
  const pathname = String(requestUrl.pathname || "").toLowerCase();
  const contentType = String(upstreamResponse.headers.get("content-type") || "").toLowerCase();

  return pathname.endsWith(".m3u8") ||
    contentType.includes("application/x-mpegurl") ||
    contentType.includes("application/vnd.apple.mpegurl");
}

function rewriteHlsManifest(manifestText, requestUrl, upstreamFinalUrl) {
  let upstreamBase = null;
  try {
    upstreamBase = new URL(upstreamFinalUrl);
  } catch {
    upstreamBase = null;
  }

  const workerOrigin = new URL(requestUrl).origin;
  const lines = String(manifestText || "").split(/\r?\n/);
  const rewritten = lines.map((line) => rewriteHlsManifestLine(line, workerOrigin, upstreamBase));
  return rewritten.join("\n");
}

function rewriteHlsManifestLine(line, workerOrigin, upstreamBase) {
  const text = String(line || "");
  const trimmed = text.trim();

  if (!trimmed) {
    return text;
  }

  if (trimmed.startsWith("#")) {
    if (trimmed.includes('URI="') || trimmed.includes("URI='")) {
      return text
        .replace(/URI="([^"]+)"/gi, (_, value) => `URI="${mapManifestUriToWorker(value, workerOrigin, upstreamBase)}"`)
        .replace(/URI='([^']+)'/gi, (_, value) => `URI='${mapManifestUriToWorker(value, workerOrigin, upstreamBase)}'`);
    }
    return text;
  }

  return mapManifestUriToWorker(trimmed, workerOrigin, upstreamBase);
}

function mapManifestUriToWorker(rawUri, workerOrigin, upstreamBase) {
  let resolved;
  try {
    if (/^https?:\/\//i.test(rawUri)) {
      resolved = new URL(rawUri);
    } else if (rawUri.startsWith("/")) {
      if (!upstreamBase) {
        return rawUri;
      }
      resolved = new URL(rawUri, upstreamBase.origin);
    } else {
      if (!upstreamBase) {
        return rawUri;
      }
      resolved = new URL(rawUri, upstreamBase);
    }
  } catch {
    return rawUri;
  }

  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
    return rawUri;
  }

  const proxied = new URL(resolved.pathname + resolved.search, workerOrigin);
  proxied.searchParams.set("_up", resolved.origin);
  return proxied.toString();
}
async function fetchWithFailover(bases, fetcher) {
  const errors = [];

  for (const base of bases) {
    try {
      const response = await fetcher(base);
      if (!shouldFailoverStatus(response.status)) {
        return response;
      }
      errors.push(`${base.origin} => ${response.status}`);
    } catch (error) {
      if (error && error.name === "AbortError") {
        throw new HttpError(499, "Client closed request");
      }
      errors.push(`${base.origin} => network_error`);
    }
  }

  throw new HttpError(502, `All upstreams failed: ${errors.join("; ") || "no upstream response"}`);
}

function shouldFailoverStatus(status) {
  return status === 513 || status === 403 || status === 404 || status === 409 || status === 429 || status === 458 || status >= 500;
}

function getUpstreamBases(env) {
  const values = [];
  const listRaw = String(env.UPSTREAM_DNS_LIST || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  if (env.UPSTREAM_DNS) {
    values.push(String(env.UPSTREAM_DNS).trim());
  }
  values.push(...listRaw);

  const unique = Array.from(new Set(values.filter(Boolean)));
  if (unique.length === 0) {
    throw new HttpError(500, "UPSTREAM_DNS or UPSTREAM_DNS_LIST is not configured");
  }

  return unique.map((value) => ensureTrailingSlash(assertHttpUrl(value)));
}

function getPreferredUpstreamBases(env, preferredDns) {
  const values = [];
  if (preferredDns) {
    values.push(preferredDns);
  }
  values.push(...getUpstreamBases(env).map((u) => u.toString()));
  const unique = Array.from(new Set(values));
  return unique.map((value) => ensureTrailingSlash(assertHttpUrl(value)));
}

function assertHttpUrl(input) {
  let parsed;
  try {
    parsed = new URL(String(input).trim());
  } catch {
    throw new HttpError(400, "Invalid URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HttpError(400, "Only http and https URLs are allowed");
  }

  return parsed;
}

function ensureTrailingSlash(url) {
  const normalized = new URL(url.toString());
  if (!normalized.pathname.endsWith("/")) {
    normalized.pathname = `${normalized.pathname}/`;
  }
  return normalized;
}

async function requestToParams(request) {
  const url = new URL(request.url);
  const params = new URLSearchParams(url.search);

  if (request.method === "GET" || request.method === "HEAD") {
    return params;
  }

  const contentType = (request.headers.get("content-type") || "").toLowerCase();

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const form = await request.formData();
    for (const [key, value] of form.entries()) {
      params.set(String(key), String(value));
    }
    return params;
  }

  if (contentType.includes("application/json")) {
    const json = await request.json().catch(() => ({}));
    for (const [key, value] of Object.entries(json || {})) {
      params.set(String(key), String(value ?? ""));
    }
    return params;
  }

  return params;
}

function proxyResponse(upstreamResponse) {
  const headers = new Headers();
  const passHeaders = ["content-type", "content-length", "cache-control", "etag", "last-modified", "content-disposition"];

  for (const name of passHeaders) {
    const value = upstreamResponse.headers.get(name);
    if (value) {
      headers.set(name, value);
    }
  }

  if (!headers.has("cache-control")) {
    headers.set("cache-control", "no-store");
  }

  return new Response(upstreamResponse.body, { status: upstreamResponse.status, headers });
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function withNoStoreAsset(response) {
  if (!response) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store, no-cache, must-revalidate");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function withCors(response, env) {
  const corsOrigin = String(env.CORS_ALLOW_ORIGIN || DEFAULT_CORS_ORIGIN);
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", corsOrigin);
  headers.set("Access-Control-Allow-Headers", "Origin,Content-Type,X-Auth-Token,Authorization,X-Refresh-Token");
  headers.set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  headers.set("Access-Control-Max-Age", "86400");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function errorToResponse(error) {
  if (error instanceof HttpError) {
    return new Response(error.message, {
      status: error.status,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  return new Response("Internal Server Error", {
    status: 500,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
