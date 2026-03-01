# Deployment Dokumentation

## 1) Voraussetzungen
- Wrangler Login vorhanden (`npx wrangler whoami`)
- Cloudflare Zone `exyuiptv.org` im gleichen Account
- GitHub CLI Login vorhanden (optional fuer Push)

## 2) Konfiguration

`wrangler.toml`:

```toml
name = "exyu-webplayer-next"
main = "_worker.js"
compatibility_date = "2026-03-01"
workers_dev = true
account_id = "21b058f792197fa0a48926aa867f845e"

[[routes]]
pattern = "webplayer.exyuiptv.org"
custom_domain = true
```

Wichtige Variablen:
- `UPSTREAM_DNS`
- `UPSTREAM_DNS_LIST`
- `MEDIA_USER_AGENT`
- `CORS_ALLOW_ORIGIN`

## 3) Deployment

```powershell
cd D:\Projekte\Webplayer\webplayer-next
npx wrangler deploy
```

Erwartete Ausgabe:
- workers.dev URL
- `webplayer.exyuiptv.org (custom domain)`

## 4) Verifikation

```powershell
Invoke-WebRequest -Uri "https://webplayer.exyuiptv.org" -UseBasicParsing
```

Erwartet: HTTP `200`

## 5) Zapping-Optimierungen (bereits umgesetzt)
- Alte HLS Session wird beim Umschalten hart beendet (`stopLoad`, `detachMedia`, `destroy`)
- Video wird beim Switch sofort geleert (`pause`, `currentTime=0`, `srcObject=null`, `load`)
- Kuenstliche Wartezeit vor Start entfernt (schnellerer Kanalwechsel)
- Retry Delays reduziert (`350ms`, `900ms`)
- Aktiver Playback-Engine-Typ (`hls`/`file`) wird sauber gespeichert und fuer Retry verwendet