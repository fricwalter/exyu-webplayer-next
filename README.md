# EXYU Webplayer Next

Neuer IPTV-Webplayer (Cloudflare Worker + Static Assets) mit:
- Login per Username/Passwort
- Live / Movies / Serien
- EPG (Short EPG + Fallback)
- Stabiler Stream-Switch mit Retry
- HLS-Proxy + Failover + Host-Pinning im Worker

## Lokaler Start

```bash
npm install
npm run dev
```

## Deploy

```bash
npm run deploy
```

Aktive URLs:
- `https://exyu-webplayer-next.morning-wind-d985.workers.dev`
- `https://webplayer.exyuiptv.org`

## Konfiguration

`wrangler.toml`:
- `UPSTREAM_DNS`
- `UPSTREAM_DNS_LIST`
- `MEDIA_USER_AGENT`
- `CORS_ALLOW_ORIGIN`

## Hinweise

- Bei Providern mit `max_connections=1` ist schnelles Zappen weiterhin providerseitig limitiert.
- Worker versucht Streams beim Umschalten sauber abzubrechen.
- Zapping wurde clientseitig beschleunigt (kein extra Delay, schnellere Retries, harter Stream-Stop).
