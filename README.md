# Ledgerline

A private, self-hosted net worth tracker. Pulls balances from your real accounts via
SimpleFIN, stores them on hardware you control, and shows one number plus the line it
traces over time.

Built because the free alternatives are free for a reason.

## What it does

- Pulls account balances from ~16,000 supported
  institutions) through the SimpleFIN Bridge
- Snapshots your net worth daily so you get a history, not just a number
- Runs as a single Docker container on your own box
- Installs to your phone home screen as a PWA
- Fetches on app open, with a 24-hour cache so it stays inside SimpleFIN's rate limit

## What it deliberately does not do

- Budgeting, categorization, envelopes, or transaction review — use Actual Budget if you
  want that
- Anything at all with your bank credentials (SimpleFIN holds those; this app only ever
  sees a read-only access URL)
- Phone you about wealth management services

## Quick start

```bash
git clone <your-remote> ledgerline && cd ledgerline
cp .env.example .env      # set APP_PASSCODE and ENCRYPTION_KEY
docker compose up -d
```

Then open the app, paste your SimpleFIN setup token, and map which accounts count as
assets vs. liabilities.

See [`docs/SETUP.md`](docs/SETUP.md) for the full walkthrough and
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how it's put together.

## Cost

| Item | Cost |
| --- | --- |
| SimpleFIN Bridge | $15/year |
| Everything else | $0 |

SimpleFIN is flat-rate — pulling more often costs nothing extra. The cache exists to stay
under the 24-requests-per-day quota, not to save money.

## License

MIT
