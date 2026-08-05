/**
 * Device registry for the unified offline/online POS.
 * Every device (Hub or Terminal) registers here on join. The Hub auto-assigns a
 * human name ("Main" for the hub, "Terminal N" for terminals). device_id is a
 * stable UUID generated on-device. Backed by the `device_registry` table
 * (scripts/create-offline-sync-tables.sql). Raw SQL via repos/pgClient.
 *
 * ADDITIVE: nothing else depends on this; safe to mount without touching order flow.
 */
const crypto = require('crypto');
const { query, getClient } = require('../../repos/pgClient');

function newDeviceId() {
  return crypto.randomUUID();
}

/**
 * Register (or refresh) a device. If new, auto-assigns a display name.
 * @returns the device row { device_id, restaurant_id, display_name, role, ... }
 */
async function registerDevice(restaurantId, deviceId, { role = 'terminal', platform = null, appVersion = null } = {}) {
  if (!restaurantId) throw new Error('restaurantId required');
  const id = deviceId || newDeviceId();
  const client = await getClient();
  try {
    await client.query('BEGIN');
    // Existing device? just refresh last_seen + metadata.
    const existing = await client.query('SELECT * FROM device_registry WHERE device_id = $1', [id]);
    if (existing.rows.length) {
      const upd = await client.query(
        `UPDATE device_registry
           SET last_seen_at = now(), platform = COALESCE($2, platform), app_version = COALESCE($3, app_version)
         WHERE device_id = $1 RETURNING *`,
        [id, platform, appVersion]
      );
      await client.query('COMMIT');
      return upd.rows[0];
    }
    // New device → assign a name. Hub = "Main"; terminals = "Terminal N" by join order.
    let displayName;
    if (role === 'hub') {
      displayName = 'Main';
    } else {
      const cnt = await client.query(
        `SELECT count(*)::int AS n FROM device_registry WHERE restaurant_id = $1 AND role <> 'hub'`,
        [restaurantId]
      );
      displayName = `Terminal ${cnt.rows[0].n + 1}`;
    }
    const ins = await client.query(
      `INSERT INTO device_registry (device_id, restaurant_id, display_name, role, platform, app_version, last_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6, now()) RETURNING *`,
      [id, restaurantId, displayName, role, platform, appVersion]
    );
    await client.query('COMMIT');
    return ins.rows[0];
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function heartbeat(deviceId) {
  if (!deviceId) return;
  await query('UPDATE device_registry SET last_seen_at = now() WHERE device_id = $1', [deviceId]);
}

async function listDevices(restaurantId) {
  const r = await query(
    'SELECT * FROM device_registry WHERE restaurant_id = $1 ORDER BY created_at ASC',
    [restaurantId]
  );
  return r.rows;
}

async function setRole(deviceId, role) {
  await query('UPDATE device_registry SET role = $2, last_seen_at = now() WHERE device_id = $1', [deviceId, role]);
}

async function renameDevice(deviceId, displayName) {
  await query('UPDATE device_registry SET display_name = $2 WHERE device_id = $1', [deviceId, displayName]);
}

module.exports = { newDeviceId, registerDevice, heartbeat, listDevices, setRole, renameDevice };
