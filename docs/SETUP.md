# Setup

## 1. SimpleFIN Bridge

Sign up at <https://beta-bridge.simplefin.org/> and subscribe ($15/year — you can't link an
institution before subscribing).

Under **Financial Institutions → New Connection**, add each institution you want tracked.
Search by name; some appear under a parent company rather than the brand you know.

Some institutions use an OAuth consent screen rather than asking for credentials in the
Bridge. That consent expires periodically and you'll need to reconnect — the app surfaces
this rather than showing you a stale number.

Then under **Apps → New Connection**, name it "Ledgerline" and create a setup token. Copy
it somewhere immediately: it's single-use and shown once.

## 2. Verify your data before building anything

```bash
SETUP_TOKEN="paste-here"
CLAIM=$(echo "$SETUP_TOKEN" | base64 -d)
ACCESS_URL=$(curl -s -X POST "$CLAIM")
curl -s "$ACCESS_URL/accounts?balances-only=1" | jq . > docs/sample-response.json
```

Open the file and check every account you expect is there. Note the sign convention on any
credit or loan account — that determines a line of normalization code.

Keep `ACCESS_URL` out of your shell history and out of git. `docs/sample-response.json` is
already gitignored.

## 3. Run it

```bash
cp .env.example .env
openssl rand -hex 32   # → ENCRYPTION_KEY
openssl rand -hex 32   # → SESSION_SECRET
# set APP_PASSCODE to something you'll type on a phone keyboard
docker compose up -d
```

## 4. Reach it from your phone

Assuming Tailscale is already on your server and your phone:

```bash
tailscale serve --bg 3000
tailscale serve status    # shows your https://<machine>.<tailnet>.ts.net URL
```

Open that URL in Safari → Share → **Add to Home Screen**. You get an icon and a
full-screen app with no browser chrome.

Nothing is exposed publicly. There's no port forward and no login page for anyone to find.

## 5. Back it up

The entire application state is one SQLite file.

```bash
# nightly, alongside your existing backups
sqlite3 /path/to/data/ledgerline.db ".backup /path/to/backups/ledgerline-$(date +%F).db"
```

The access URL inside is encrypted, but the balances aren't — if these backups leave your
network, encrypt them at the destination.
