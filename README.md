# PumpPortal + Helius New Creation Bot

This bot listens to real-time Pump.fun launches through PumpPortal WebSocket, filters token metadata and socials first, then enriches only the surviving candidates with Helius funded-by and wallet-balance analysis before printing the tokens that pass your filters.

## What it does

- Subscribes to new Pump.fun launches in real time through PumpPortal WebSocket
- Filters client-side for Telegram and X communities before any Helius calls
  - X community can come from either the GMGN `twitter` field or the `website` field if that metadata contains an `x.com/i/communities/...` link
- Enriches creator wallets with Helius funded-by and wallet-balance analysis
  - Can require the creator wallet to be funded by a labeled exchange such as Binance or Bybit
- Runs only inside a configured daily time window
- Polls repeatedly on a timer, or once with `--once`

## Why social filtering is client-side

PumpPortal launch events are fast, but social links still need to be derived from token metadata. So the bot receives the launch first, then filters socials locally before doing any Helius or Jupiter work.

## Setup

```powershell
npm install
Copy-Item .env.example .env
```

Fill in at least `HELIUS_API_KEY`, your run window, and your funding thresholds.

## Run

```powershell
npm run run:once
npm run dev
```

## Fly.io

This repo includes a minimal [fly.toml](/c:/Users/Jerry A/Projects/copytrade bot/fly.toml) and [Dockerfile](/c:/Users/Jerry A/Projects/copytrade bot/Dockerfile) so the bot can run as an always-on worker on Fly.io.

Typical deploy flow:

```powershell
fly launch --no-deploy
fly secrets set HELIUS_API_KEY=... JUP_API_KEY=... SOLANA_PRIVATE_KEY_B58=...
fly deploy
```

Recommended notes:

- Keep this as a worker-style app with one always-on Machine.
- For a websocket worker, do not rely on autostop/autostart.
- Edit the `app` name in `fly.toml` before first deploy.
