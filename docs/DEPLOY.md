# Deploy

One container, one SQLite file, reachable only over Tailscale. Nothing is exposed to the
LAN or the internet, and there is no login in front of it until the passcode gate lands —
so the network boundary *is* the security model for now.

## What the image contains

Node strips TypeScript at runtime, so the server ships as source and there is no build
step for it. The image is `node:24-alpine` plus production dependencies, `server/src`,
and the built PWA. It runs as the unprivileged `node` user with a read-only root
filesystem; the only writable paths are the mounted volumes and `/tmp`.

Node 24 specifically: the server uses `node:sqlite`, which is only usable without flags
from 22.5 and stable in 24. There is no compiled artifact, so a version mismatch surfaces
at runtime rather than at build time.

## On TrueNAS SCALE

The Apps UI installs from a registry rather than building from a Dockerfile, so use the
published image.

1. **Create a dataset** for the state, e.g. `tank/apps/ledgerline`, with `data` and
   `backups` directories inside it. This is the entire application state — everything
   else is disposable.

2. **Apps → Discover Apps → Custom App** (or *Install via YAML* on newer releases) and
   paste `docker-compose.yml` from this repository, changing the volume paths to the
   dataset:

   ```yaml
   volumes:
     - /mnt/tank/apps/ledgerline/data:/data
     - /mnt/tank/apps/ledgerline/backups:/backups
   ```

   Create those directories **before** installing, and give them to uid 1000. The
   container runs as the unprivileged `node` user, and a bind mount that Docker creates
   for you is owned by root — the app starts and then dies opening the database:

   ```bash
   sudo mkdir -p /mnt/tank/apps/ledgerline/{data,backups}
   sudo chown -R 1000:1000 /mnt/tank/apps/ledgerline
   ```

   The symptom, if you skip it, is `SQLITE_CANTOPEN` or `EACCES` on `/data/ledgerline.db`
   in `docker logs`.

3. **Set the environment variables.** The Install-via-YAML dialog has only a name and the
   compose body — there is no separate environment field, and `env_file: .env` will not
   work because there is no `.env` on that side. Delete the `env_file` line and inline
   them instead, at the same indent as `volumes:`:

   ```yaml
       environment:
         ENCRYPTION_KEY: <64 hex characters>
         TZ: America/New_York
   ```

   Only `ENCRYPTION_KEY` is required today; the server refuses to start without it rather
   than running unable to decrypt the access URL. `SESSION_SECRET` and `APP_PASSCODE` are
   not read by anything until the passcode gate exists.

   Note that inlining puts the key in the app's stored configuration in plain text. Do
   not paste that YAML anywhere public.

   The full set, for reference:

   | Variable | Value |
   | --- | --- |
   | `ENCRYPTION_KEY` | `openssl rand -hex 32` |
   | `SESSION_SECRET` | `openssl rand -hex 32` |
   | `APP_PASSCODE` | something typeable on a phone |
   | `TZ` | your zone, so the 23:55 snapshot lands on the right day |

   `ENCRYPTION_KEY` is not recoverable. If it changes, the stored access URL cannot be
   decrypted and onboarding has to be redone with a fresh setup token. Back it up
   somewhere that is not this repository.

4. **Keep the port binding on loopback.** `127.0.0.1:3000:3000`. Changing it to
   `3000:3000` publishes your balances to every device on the network.

## Reaching it from a phone

Tailscale runs on the NAS host, connects to `127.0.0.1:3000`, and publishes to the
tailnet with a real certificate:

```bash
tailscale serve --bg 3000
tailscale serve status
```

That prints `https://<machine>.<tailnet>.ts.net`. Open it in Safari, then Share →
**Add to Home Screen**.

Use the HTTPS name rather than the tailnet IP. Service workers and installable PWAs
require a secure context, so over plain `http://100.x.y.z:3000` the app renders but does
not install and does not cache offline.

## Moving an existing database

The state is one file plus its WAL sidecars. Stop the app before copying, or the copy can
capture a torn write:

```bash
cp data/ledgerline.db* /mnt/tank/apps/ledgerline/data/
```

Alternatively run `npm run backup` first and copy the single file it produces — that one
is transactionally consistent and safe to take while running.

Not moving the database means re-running onboarding, which needs a fresh setup token —
they are single-use.

## Backups

```bash
docker exec ledgerline node src/cli/backup.ts --out /backups --keep 14
```

Uses `VACUUM INTO`, which is transactional and safe against a live database. A plain file
copy of an open SQLite database is the classic way to produce a backup that restores
corrupt.

Schedule it in **System → Advanced → Cron Jobs**, daily, after the 23:55 snapshot.

The balances inside are not encrypted — only the access URL is. If these backups leave
your network, encrypt them at the destination.

## Health

```bash
curl -s localhost:3000/api/health
```

Reports the last successful sync per connection, cache age against the TTL, and requests
used against the daily cap. The container healthcheck hits the same endpoint, so a
degraded sync shows up in `docker ps`.

## Updating

```bash
docker compose pull && docker compose up -d
```

The schema applies itself on boot and every statement is `CREATE TABLE IF NOT EXISTS`, so
restarting on an existing database is a no-op. There is no migration runner yet — the
first change that alters a column rather than adding one will need one.
