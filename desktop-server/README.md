# DineOpen Server (desktop installer)

A **self-contained** on-prem server the restaurant installs like any normal app —
**no Node, no PostgreSQL, no command line**. It bundles:

- the real `dine-backend` (Electron's built-in Node runs it),
- an embedded PostgreSQL (real per-OS binary via `embedded-postgres`),
- the LAN real-time (socket.io) bus.

On launch it starts the database + backend on **port 3003** and shows the LAN
address the terminals should use. Every terminal (desktop app or Android APK) just
enters that address under **Settings → Local Server**.

```
  Restaurant installs:  DineOpen-Server-Setup.exe  (Windows)  /  DineOpen-Server.dmg (Mac)
  → double-click, it runs. Terminals connect to http://<this-pc-ip>:3003
```

## Build the installer (done by you, once, per OS)

Installers are OS-specific and must be built ON that OS (electron-builder can't
cross-build the native Postgres binary reliably):

```bash
cd dine-backend
npm ci                         # backend deps
npm i embedded-postgres        # bundles the PG binary for THIS os into node_modules
# (optional but recommended) bundle an exact schema clone:
pg_dump --schema-only --no-owner --no-privileges "<CLOUD_DATABASE_URL>" > scripts/offline-schema.sql

cd desktop-server
npm install                    # electron + electron-builder
npm run dist:win               # → dist/DineOpen-Server-Setup-1.0.0.exe   (run on Windows)
npm run dist:mac               # → dist/DineOpen-Server-1.0.0.dmg          (run on macOS)
```

The build copies the whole backend (incl. `node_modules/@embedded-postgres/<os>`)
into the app's resources, so the shipped installer needs nothing on the target machine.

## What the operator does

1. Install the app on the "server" machine (wired ethernet + a reserved LAN IP is best).
2. (Optional) put a `.env.local` next to the backend with `JWT_SECRET` (same as prod)
   and `SYNC_MODE` / `CLOUD_DATABASE_URL` if they want cloud sync. Without it, it runs
   as a pure offline island.
3. Launch it — it shows `http://<ip>:3003`. Enter that on each terminal.

## Runs unattended (self-healing)

Built to sit in a restaurant with nobody watching it:

- **Auto-restart on crash** — if the backend stops unexpectedly it respawns automatically
  (exponential backoff). A health watchdog polls `/api/health`; a wedged backend is
  bounced, and a persistently stuck server triggers a clean app relaunch (which also
  recovers Postgres).
- **Starts on boot** — after a power cut the server comes back by itself (toggle:
  "Start automatically when this computer turns on").
- **Single instance** — a second copy can't start (would fight over port 3003 / the data
  dir); it just focuses the existing window.
- **System tray** — closing the window keeps the server running; use the tray icon to
  reopen it or to **Quit server** (with confirmation, so it isn't shut down by accident).
- **Windows Firewall** — the installer opens inbound TCP **3003** so terminals can
  connect (also attempted at runtime as a fallback). On Mac, allow it if macOS prompts.
- **Stable address** — terminals can use `http://dineopen-server.local:3003` (shown first
  in the window), which keeps working even if the machine's IP changes. Best practice:
  also reserve a fixed IP for this machine in the Wi-Fi router.
- **Copy diagnostics** — the Activity card has a one-click export (versions, OS, data dir,
  backup status, recent logs — no secrets) to send for remote support. Logs also persist to
  `~/DineOpenServer/logs/server.log` (rotated at 2 MB).

## Software updates (in-app)

The status window has a **Software update** card:

- **Check for updates → Download → Restart & install** (admin-triggered, never forced —
  installing briefly restarts the server, so do it after service).
- Before a new version's schema migrations run, the app **automatically snapshots the
  database** (a cold copy of `pgdata` → `pgdata-backup-<oldversion>-<ts>`, last 2 kept),
  so a bad update is always recoverable.
- On boot the forked backend runs **versioned schema migrations** (`/migrations/NNN_*.sql`,
  tracked in `schema_migrations`) — so an update self-heals the schema with **no manual
  SQL step**. This is the single mechanism for schema changes across cloud + offline.

**Publishing an update (you, per release):** bump `desktop-server/package.json` `version`,
`npm run dist:win` / `dist:mac`, then upload the generated installer **and** `latest.yml` /
`latest-mac.yml` to the feed URL in `build.publish` (`https://updates.dineopen.com/server/`
— change to your host). Terminals reconnect automatically after the ~10 s restart. To point
a site at a different feed without rebuilding, set `UPDATE_FEED_URL` in the app's `.env.local`.
If no feed is configured, the app runs fine and the update card shows "not configured".

## Data & backups

**Where the data lives (survives uninstall):** the database is stored in a stable
folder **outside the app** — `~/DineOpenServer/pgdata` (Windows: `C:\Users\<name>\DineOpenServer\pgdata`).
Uninstalling or reinstalling the app does **not** touch it. Override the location with
`DINEOPEN_DATA_DIR` in `.env.local` (e.g. a dedicated data drive). Existing installs
that had data in the old in-app location are migrated to the new folder automatically
on first launch. The **Open** button in the window opens this folder.

**Backup & restore (in the app):**
- **Back up now** → pick a folder (an **external drive / USB** is safest — if the
  machine dies, the backup is elsewhere). Postgres pauses for a few seconds for a
  consistent copy, then resumes; terminals reconnect automatically. Do it after service.
- **Auto-backup** → toggle on, set an interval and a target folder; the app backs up on
  schedule and keeps the newest 7.
- **Restore…** → pick a backup folder; the current data is set aside first (reversible),
  then replaced and the server restarts. Cross-Postgres-major-version restores are blocked
  with a clear message (can't restore e.g. a PG 16 backup into a PG 18 app).
- Every backup is **verified** (checked to be a complete, restorable data dir) before it's
  counted — a copy that came out incomplete is discarded and reported, not silently kept.
- If a scheduled backup was **missed** because the machine was off, one runs shortly after
  the next launch (catch-up).
- Pre-update snapshots are also kept in `~/DineOpenServer/backups` automatically.

**Off-site backup:** set `SYNC_MODE=periodic` + `CLOUD_DATABASE_URL` in `.env.local` to
also sync up to your cloud Postgres whenever the internet is available (see
`docs/offline-local-server.md`). Local backup + cloud sync together = the safest setup.

- Keep the machine on a UPS (Postgres WAL survives power loss).
- `pg_dump` is **not** bundled with the embedded Postgres — use the in-app Backup button
  (a full data-dir copy), not `pg_dump`.

## Notes

- First launch does one-time DB setup (a few seconds).
- Seed the restaurant's menu/tables once while online (see `docs/offline-local-server.md`,
  "Seed this restaurant's data").
- For all-Android sites with no desktop, run the same backend on a small Linux box
  (Raspberry Pi / mini-PC) instead — `embedded-postgres` ships linux-arm64/x64 too.
