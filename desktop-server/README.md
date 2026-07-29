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

## Data & backups

- Postgres data lives in the app's userData dir (`.../pgdata`), so it survives updates.
- Take a periodic backup: `pg_dump "postgresql://dine_app:dineopen_local@127.0.0.1:5433/dine"`.
- Keep the machine on a UPS (Postgres WAL survives power loss).

## Notes

- First launch does one-time DB setup (a few seconds).
- Seed the restaurant's menu/tables once while online (see `docs/offline-local-server.md`,
  "Seed this restaurant's data").
- For all-Android sites with no desktop, run the same backend on a small Linux box
  (Raspberry Pi / mini-PC) instead — `embedded-postgres` ships linux-arm64/x64 too.
