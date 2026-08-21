// Always-on VM entrypoint (pg-full-migration deployment on dine-be-vm).
//
// Loads prod env from env.json, then boots the real backend (index.js) across a
// small cluster so both vCPUs are used instead of one.
//
// SAFE TO CLUSTER on the cloud VM: the only in-process background singletons
// (apiSyncWorker, cloudSyncWorker, lanRealtime socket.io, lanDiscovery) are all
// gated behind LOCAL_SERVER_MODE / CLOUD_SYNC_ENABLED, which are UNSET here — so
// they never run on the cloud, and there is nothing that would double-fire per
// worker. The only always-on timer is an in-memory rate-map cleanup, which is
// correctly per-process. Node's cluster module shares the listen port across
// workers (round-robin), so index.js's app.listen(PORT) needs no change.
//
// Worker count = WEB_CONCURRENCY (default min(vCPUs, 2)). Per-worker pg pool =
// PG_POOL_MAX (default 10); keep WORKERS × PG_POOL_MAX under the DB's
// max_connections.
const fs = require('fs');
const path = require('path');
const cluster = require('cluster');
const os = require('os');

try {
  const env = JSON.parse(fs.readFileSync(path.join(__dirname, 'env.json'), 'utf8'));
  for (const [k, v] of Object.entries(env)) if (process.env[k] === undefined) process.env[k] = v;
} catch (e) {
  console.error('Failed to load env.json:', e.message);
  process.exit(1);
}

const WORKERS = Math.max(1, parseInt(process.env.WEB_CONCURRENCY, 10) || Math.min(os.cpus().length, 2));

if (cluster.isPrimary && WORKERS > 1) {
  console.log(`[cluster] primary ${process.pid} forking ${WORKERS} workers`);
  for (let i = 0; i < WORKERS; i++) cluster.fork();

  // Respawn dead workers, but bail out of a tight crash-loop.
  let crashes = 0;
  let windowStart = Date.now();
  cluster.on('exit', (worker, code, signal) => {
    const now = Date.now();
    if (now - windowStart > 60000) { crashes = 0; windowStart = now; }
    crashes++;
    if (crashes > 10) {
      console.error('[cluster] >10 worker crashes in 60s — exiting so systemd restarts cleanly');
      process.exit(1);
    }
    console.warn(`[cluster] worker ${worker.process.pid} exited (${signal || code}); respawning`);
    cluster.fork();
  });
} else {
  // Worker (or single-process mode when WORKERS=1): run the real app.
  require('./index.js');
}
