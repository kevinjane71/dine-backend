// Timezone-aware date helpers for consistent date handling across endpoints.
// tzOffset = value of browser's getTimezoneOffset() (minutes from UTC, negative for east)
// e.g. Qatar UTC+3 → tzOffset = -180, IST UTC+5:30 → tzOffset = -330
//
// dayStartHour = custom business day start hour (0–23, default 0 = midnight).
// When set (e.g. 3), the "business day" runs 3:00 AM → 2:59:59 AM next day.
// An order at 1:30 AM is considered part of the previous business day.

// Get YYYY-MM-DD for a given Date in the client's timezone.
// When dayStartHour > 0, subtracts that many hours before computing the date,
// so timestamps between midnight and dayStartHour fall into the previous date.
function dateStrInTZ(d, tzOffset, dayStartHour) {
  const dsh = (dayStartHour && dayStartHour > 0) ? dayStartHour : 0;
  const effective = dsh > 0 ? new Date(d.getTime() - dsh * 3600000) : d;
  if (tzOffset === undefined || tzOffset === null) return effective.toISOString().split('T')[0];
  const ms = effective.getTime() - tzOffset * 60000;
  const shifted = new Date(ms);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

// Get start-of-day and end-of-day as UTC Date objects for a date string in client TZ.
// When dayStartHour > 0, the day starts at dayStartHour:00 instead of midnight,
// and ends at dayStartHour:00 the next day minus 1ms.
function dateBoundsInTZ(dateStr, tzOffset, dayStartHour) {
  const dsh = (dayStartHour && dayStartHour > 0) ? dayStartHour : 0;
  const [y, m, d] = dateStr.split('-').map(Number);
  const midnightUTC = Date.UTC(y, m - 1, d, 0, 0, 0, 0);
  const startMs = midnightUTC + tzOffset * 60000 + dsh * 3600000;
  return {
    start: new Date(startMs),
    end: new Date(startMs + 24 * 60 * 60 * 1000 - 1)
  };
}

// Get "today" date string and boundaries in client timezone
function todayInTZ(tzOffset, dayStartHour) {
  const now = new Date();
  const todayStr = dateStrInTZ(now, tzOffset, dayStartHour);
  const bounds = dateBoundsInTZ(todayStr, tzOffset, dayStartHour);
  return { dateStr: todayStr, ...bounds };
}

// Parse tz query param from request (returns number or undefined)
function parseTZ(req) {
  const tz = req.query?.tz;
  if (tz === undefined || tz === null || tz === '') return undefined;
  const n = Number(tz);
  return isNaN(n) ? undefined : n;
}

// Parse dayStart query param from request (returns number 0–23, default 0)
function parseDayStart(req) {
  const ds = req.query?.dayStart;
  if (ds === undefined || ds === null || ds === '') return 0;
  const n = Number(ds);
  return (isNaN(n) || n < 0 || n > 23) ? 0 : Math.floor(n);
}

// Build date range boundaries from period/startDate/endDate with timezone support
function buildDateRange(period, startDate, endDate, tzOffset, dayStartHour) {
  const now = new Date();
  const todayStr = tzOffset !== undefined ? dateStrInTZ(now, tzOffset, dayStartHour) : now.toISOString().split('T')[0];
  let rangeStart, rangeEnd;

  function _daysAgo(n) {
    const d = new Date(todayStr + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() - n);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }

  if (startDate && endDate) {
    if (tzOffset !== undefined) {
      rangeStart = dateBoundsInTZ(startDate, tzOffset, dayStartHour).start;
      rangeEnd = dateBoundsInTZ(endDate, tzOffset, dayStartHour).end;
    } else {
      rangeStart = new Date(startDate); rangeStart.setHours(0, 0, 0, 0);
      rangeEnd = new Date(endDate); rangeEnd.setHours(23, 59, 59, 999);
    }
  } else if (period === 'yesterday') {
    const yDate = _daysAgo(1);
    if (tzOffset !== undefined) {
      const b = dateBoundsInTZ(yDate, tzOffset, dayStartHour);
      rangeStart = b.start; rangeEnd = b.end;
    } else {
      rangeStart = new Date(now); rangeStart.setDate(now.getDate() - 1); rangeStart.setHours(0, 0, 0, 0);
      rangeEnd = new Date(now); rangeEnd.setDate(now.getDate() - 1); rangeEnd.setHours(23, 59, 59, 999);
    }
  } else if (period === '7d' || period === 'last7days') {
    rangeStart = tzOffset !== undefined ? dateBoundsInTZ(_daysAgo(7), tzOffset, dayStartHour).start : (() => { const d = new Date(now); d.setDate(d.getDate() - 7); d.setHours(0, 0, 0, 0); return d; })();
    rangeEnd = now;
  } else if (period === '30d' || period === 'last30days') {
    rangeStart = tzOffset !== undefined ? dateBoundsInTZ(_daysAgo(30), tzOffset, dayStartHour).start : (() => { const d = new Date(now); d.setDate(d.getDate() - 30); d.setHours(0, 0, 0, 0); return d; })();
    rangeEnd = now;
  } else if (period === '90d') {
    rangeStart = tzOffset !== undefined ? dateBoundsInTZ(_daysAgo(90), tzOffset, dayStartHour).start : (() => { const d = new Date(now); d.setDate(d.getDate() - 90); d.setHours(0, 0, 0, 0); return d; })();
    rangeEnd = now;
  } else {
    // today (default)
    if (tzOffset !== undefined) {
      const b = dateBoundsInTZ(todayStr, tzOffset, dayStartHour);
      rangeStart = b.start; rangeEnd = now;
    } else {
      rangeStart = new Date(now); rangeStart.setHours(0, 0, 0, 0);
      rangeEnd = now;
    }
  }

  return { start: rangeStart, end: rangeEnd, todayStr };
}

module.exports = { dateStrInTZ, dateBoundsInTZ, todayInTZ, parseTZ, parseDayStart, buildDateRange };
