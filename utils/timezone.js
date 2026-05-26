// Timezone-aware date helpers for consistent date handling across endpoints.
// tzOffset = value of browser's getTimezoneOffset() (minutes from UTC, negative for east)
// e.g. Qatar UTC+3 → tzOffset = -180, IST UTC+5:30 → tzOffset = -330

// Get YYYY-MM-DD for a given Date in the client's timezone
function dateStrInTZ(d, tzOffset) {
  if (tzOffset === undefined || tzOffset === null) return d.toISOString().split('T')[0];
  const ms = d.getTime() - tzOffset * 60000;
  const shifted = new Date(ms);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

// Get start-of-day and end-of-day as UTC Date objects for a date string in client TZ
function dateBoundsInTZ(dateStr, tzOffset) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const midnightUTC = Date.UTC(y, m - 1, d, 0, 0, 0, 0);
  const startMs = midnightUTC + tzOffset * 60000;
  return {
    start: new Date(startMs),
    end: new Date(startMs + 24 * 60 * 60 * 1000 - 1)
  };
}

// Get "today" date string and boundaries in client timezone
function todayInTZ(tzOffset) {
  const now = new Date();
  const todayStr = dateStrInTZ(now, tzOffset);
  const bounds = dateBoundsInTZ(todayStr, tzOffset);
  return { dateStr: todayStr, ...bounds };
}

// Parse tz query param from request (returns number or undefined)
function parseTZ(req) {
  const tz = req.query?.tz;
  if (tz === undefined || tz === null || tz === '') return undefined;
  const n = Number(tz);
  return isNaN(n) ? undefined : n;
}

// Build date range boundaries from period/startDate/endDate with timezone support
function buildDateRange(period, startDate, endDate, tzOffset) {
  const now = new Date();
  const todayStr = tzOffset !== undefined ? dateStrInTZ(now, tzOffset) : now.toISOString().split('T')[0];
  let rangeStart, rangeEnd;

  function _daysAgo(n) {
    const d = new Date(todayStr + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() - n);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }

  if (startDate && endDate) {
    if (tzOffset !== undefined) {
      rangeStart = dateBoundsInTZ(startDate, tzOffset).start;
      rangeEnd = dateBoundsInTZ(endDate, tzOffset).end;
    } else {
      rangeStart = new Date(startDate); rangeStart.setHours(0, 0, 0, 0);
      rangeEnd = new Date(endDate); rangeEnd.setHours(23, 59, 59, 999);
    }
  } else if (period === 'yesterday') {
    const yDate = _daysAgo(1);
    if (tzOffset !== undefined) {
      const b = dateBoundsInTZ(yDate, tzOffset);
      rangeStart = b.start; rangeEnd = b.end;
    } else {
      rangeStart = new Date(now); rangeStart.setDate(now.getDate() - 1); rangeStart.setHours(0, 0, 0, 0);
      rangeEnd = new Date(now); rangeEnd.setDate(now.getDate() - 1); rangeEnd.setHours(23, 59, 59, 999);
    }
  } else if (period === '7d' || period === 'last7days') {
    rangeStart = tzOffset !== undefined ? dateBoundsInTZ(_daysAgo(7), tzOffset).start : (() => { const d = new Date(now); d.setDate(d.getDate() - 7); d.setHours(0, 0, 0, 0); return d; })();
    rangeEnd = now;
  } else if (period === '30d' || period === 'last30days') {
    rangeStart = tzOffset !== undefined ? dateBoundsInTZ(_daysAgo(30), tzOffset).start : (() => { const d = new Date(now); d.setDate(d.getDate() - 30); d.setHours(0, 0, 0, 0); return d; })();
    rangeEnd = now;
  } else if (period === '90d') {
    rangeStart = tzOffset !== undefined ? dateBoundsInTZ(_daysAgo(90), tzOffset).start : (() => { const d = new Date(now); d.setDate(d.getDate() - 90); d.setHours(0, 0, 0, 0); return d; })();
    rangeEnd = now;
  } else {
    // today (default)
    if (tzOffset !== undefined) {
      const b = dateBoundsInTZ(todayStr, tzOffset);
      rangeStart = b.start; rangeEnd = now;
    } else {
      rangeStart = new Date(now); rangeStart.setHours(0, 0, 0, 0);
      rangeEnd = now;
    }
  }

  return { start: rangeStart, end: rangeEnd, todayStr };
}

module.exports = { dateStrInTZ, dateBoundsInTZ, todayInTZ, parseTZ, buildDateRange };
