import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import config from './config.js';
import { getRouteShortName, getTripInfo, getStopName, resolveStopId, getScheduledTripsForStop, getActiveServiceIds } from './gtfs-static.js';
import { logError } from './logger.js';

// In-memory real-time cache
// Maps trip_id -> TripUpdate object
let tripUpdatesCache = new Map();
let lastFetchTime = null;
let pollIntervalId = null;

/**
 * Returns formatted date and time strings for the Europe/Dublin timezone.
 */
function getDublinTimeStrings(nowDate) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Dublin',
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  
  const parts = formatter.formatToParts(nowDate);
  const year = parts.find(p => p.type === 'year').value;
  const month = parts.find(p => p.type === 'month').value;
  const day = parts.find(p => p.type === 'day').value;
  const hour = parts.find(p => p.type === 'hour').value;
  const minute = parts.find(p => p.type === 'minute').value;
  const second = parts.find(p => p.type === 'second').value;
  
  return {
    dateStr: `${year}${month}${day}`, // YYYYMMDD
    timeStr: `${hour}:${minute}:${second}` // HH:MM:SS
  };
}

/**
 * Parses a GTFS scheduled time string (HH:MM:SS) and trip start date (YYYYMMDD)
 * into a UTC POSIX timestamp adjusted for the Europe/Dublin timezone.
 */
function parseScheduledTime(startDateStr, timeStr) {
  const year = parseInt(startDateStr.substring(0, 4), 10);
  const month = parseInt(startDateStr.substring(4, 6), 10) - 1;
  const day = parseInt(startDateStr.substring(6, 8), 10);
  
  const parts = timeStr.split(':');
  let hour = parseInt(parts[0], 10);
  const minute = parseInt(parts[1], 10);
  const second = parseInt(parts[2], 10);
  
  let dayOffset = 0;
  if (hour >= 24) {
    dayOffset = Math.floor(hour / 24);
    hour = hour % 24;
  }

  // Target local components
  const targetYear = year;
  const targetMonth = month;
  const targetDay = day + dayOffset;
  const targetHour = hour;
  const targetMinute = minute;
  const targetSecond = second;

  // Step 1: Construct a date in UTC representing these same local components
  const utcDate = new Date(Date.UTC(targetYear, targetMonth, targetDay, targetHour, targetMinute, targetSecond));
  
  // Step 2: Format that UTC date in the target timezone (Europe/Dublin) to get its local components
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Dublin',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  });
  
  try {
    const parts = formatter.formatToParts(utcDate);
    const dy = parseInt(parts.find(p => p.type === 'year').value, 10);
    const dm = parseInt(parts.find(p => p.type === 'month').value, 10) - 1;
    const dd = parseInt(parts.find(p => p.type === 'day').value, 10);
    const dh = parseInt(parts.find(p => p.type === 'hour').value, 10);
    const dmin = parseInt(parts.find(p => p.type === 'minute').value, 10);
    const ds = parseInt(parts.find(p => p.type === 'second').value, 10);
    
    // Step 3: Reconstruct the local date as a UTC timestamp
    const localUtc = Date.UTC(dy, dm, dd, dh, dmin, ds);
    
    // Step 4: The difference between the local UTC and the original UTC is the timezone offset in ms
    const offsetMs = localUtc - utcDate.getTime();
    
    // Step 5: Subtract the offset from the target UTC timestamp to get the actual UTC POSIX timestamp
    const targetUtc = Date.UTC(targetYear, targetMonth, targetDay, targetHour, targetMinute, targetSecond) - offsetMs;
    return Math.floor(targetUtc / 1000);
  } catch (err) {
    logError(err, 'Failed to parse timezone offset, falling back to UTC');
    return Math.floor(utcDate.getTime() / 1000);
  }
}
// Exponential backoff state
let consecutiveFailures = 0;
const MAX_BACKOFF_SEC = 300; // Cap at 5 minutes

/**
 * Fetches real-time TripUpdates from NTA and updates the in-memory cache.
 * Returns true on success, false on failure.
 */
async function fetchRealtimeUpdates() {
  console.log('🔄 Fetching real-time updates from NTA GTFS-R feed...');
  const startTime = Date.now();

  try {
    const response = await fetch('https://api.nationaltransport.ie/gtfsr/v2/TripUpdates', {
      headers: {
        'x-api-key': config.ntaApiKey
      }
    });

    if (response.status === 429) {
      consecutiveFailures++;
      const backoffSec = Math.min(config.rtFetchIntervalSec * Math.pow(2, consecutiveFailures - 1), MAX_BACKOFF_SEC);
      console.warn(`⚠️ NTA API rate limit hit (429). Backing off for ${backoffSec}s (attempt #${consecutiveFailures}).`);
      scheduleNextFetch(backoffSec * 1000);
      return;
    }

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status} ${response.statusText}`);
    }

    const buffer = await response.arrayBuffer();
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buffer));
    
    const tempCache = new Map();
    let tripUpdateCount = 0;

    for (const entity of feed.entity) {
      if (entity.tripUpdate) {
        const tripUpdate = entity.tripUpdate;
        const trip = tripUpdate.trip;
        const tripId = trip.tripId;

        if (tripId) {
          tempCache.set(tripId, tripUpdate);
          tripUpdateCount++;
        }
      }
    }

    // Swap cache atomically
    tripUpdatesCache = tempCache;
    lastFetchTime = new Date();
    consecutiveFailures = 0; // Reset on success
    
    console.log(`✅ Cached real-time updates in ${Date.now() - startTime}ms.`);
    console.log(`   - Total trip updates cached: ${tripUpdateCount}`);
    scheduleNextFetch(config.rtFetchIntervalSec * 1000);
  } catch (error) {
    consecutiveFailures++;
    const backoffSec = Math.min(config.rtFetchIntervalSec * Math.pow(2, consecutiveFailures - 1), MAX_BACKOFF_SEC);
    logError(error, `Failed to fetch GTFS-RT updates (attempt #${consecutiveFailures}, next retry in ${backoffSec}s)`);
    scheduleNextFetch(backoffSec * 1000);
  }
}

/**
 * Schedules the next fetch after a given delay, replacing any existing schedule.
 */
function scheduleNextFetch(delayMs) {
  if (pollIntervalId) {
    clearTimeout(pollIntervalId);
  }
  pollIntervalId = setTimeout(fetchRealtimeUpdates, delayMs);
}

/**
 * Starts background polling of NTA real-time feed.
 */
export function startRealtimePolling() {
  if (config.mockMode) {
    console.log('ℹ️ Running in MOCK MODE. Real-time background fetch polling is disabled.');
    lastFetchTime = new Date();
    return;
  }

  if (pollIntervalId) {
    clearTimeout(pollIntervalId);
  }

  consecutiveFailures = 0;

  // Fetch immediately on start, then schedule next via backoff
  fetchRealtimeUpdates();
  console.log(`⏱️ Real-time polling started (base interval: ${config.rtFetchIntervalSec}s, max backoff: ${MAX_BACKOFF_SEC}s).`);
}

/**
 * Generates deterministic mock predictions for a stop ID.
 * This simulates a realistic countdown for local testing/demo purposes.
 */
function generateMockPredictions(stopId, now) {
  const currentMinute = Math.floor(now / 60) % 60;
  const currentSecond = now % 60;
  
  // Extract trailing digits of stopId to create a hash
  const stopNumDigits = stopId.toString().replace(/\D/g, '');
  const stopNumTail = stopNumDigits.substring(Math.max(0, stopNumDigits.length - 4));
  const stopNum = parseInt(stopNumTail, 10) || 0;
  const routes = [];
  
  if (stopNum % 2 === 0) {
    routes.push({ route: '140', destination: 'Rathmines', offset: 5, interval: 10 });
    routes.push({ route: '46A', destination: 'Dun Laoghaire', offset: 8, interval: 15 });
  } else {
    routes.push({ route: '15', destination: 'Clongriffin', offset: 3, interval: 8 });
    routes.push({ route: '39A', destination: 'UCD Belfield', offset: 6, interval: 12 });
  }

  const predictions = [];

  for (const r of routes) {
    const minSincePeriodStart1 = (currentMinute - r.offset + 60) % r.interval;
    const minsToArrive1 = r.interval - minSincePeriodStart1;
    const arrivalTime1 = now + (minsToArrive1 * 60) - currentSecond;
    
    const minsToArrive2 = minsToArrive1 + r.interval;
    const arrivalTime2 = now + (minsToArrive2 * 60) - currentSecond;

    predictions.push({
      route: r.route,
      destination: r.destination,
      arrivalTime: arrivalTime1,
      live: true
    });

    predictions.push({
      route: r.route,
      destination: r.destination,
      arrivalTime: arrivalTime2,
      live: true
    });
  }

  return predictions;
}


/**
 * Returns formatted predictions for a specific stop ID (Option A grouped).
 */
export function getPredictionsForStop(stopId) {
  const nowSec = Math.floor(Date.now() / 1000);
  
  // Resolve the stop code/ID first
  const officialStopId = resolveStopId(stopId);

  // 1. Get raw predictions
  let rawPredictions = [];

  if (config.mockMode) {
    rawPredictions = generateMockPredictions(officialStopId, nowSec);
  } else {
    // A. Get current Dublin date and time (adjusted back by 10 minutes to catch delayed/active buses)
    const tenMinsAgo = new Date((nowSec - 10 * 60) * 1000);
    const { timeStr } = getDublinTimeStrings(tenMinsAgo);
    const todayStr = getDublinTimeStrings(new Date(nowSec * 1000)).dateStr; // today's date "YYYYMMDD"
    
    // Get active service IDs for today
    const activeServices = getActiveServiceIds(todayStr);

    // B. Query scheduled trips for this stop from SQLite database
    const scheduledTrips = getScheduledTripsForStop(officialStopId, timeStr);
    
    // C. Reconcile scheduled trips with real-time feed updates
    for (const s of scheduledTrips) {
      // Look up static trip details first to filter active services
      const tripInfo = getTripInfo(s.trip_id);
      if (!tripInfo || !activeServices.has(tripInfo.serviceId)) {
        continue; // Skip inactive schedules for today
      }

      const scheduledTimeSec = parseScheduledTime(todayStr, s.arrival_time);
      if (!scheduledTimeSec) continue;

      let delay = 0;
      let live = false;

      // Check if we have a live update for this trip in the cache
      const liveUpdate = tripUpdatesCache.get(s.trip_id);
      if (liveUpdate) {
        live = true;
        
        // Find delay for this stop
        const updates = liveUpdate.stopTimeUpdate || [];
        const exact = updates.find(u => u.stopId === officialStopId);
        
        if (exact) {
          delay = exact.arrival?.delay !== undefined 
            ? exact.arrival.delay 
            : (exact.departure?.delay !== undefined ? exact.departure.delay : 0);
        } else {
          // Propagate delay: find any stop update in the trip that has a delay, and propagate it
          const anyUpdate = updates.find(u => u.arrival?.delay !== undefined || u.departure?.delay !== undefined);
          if (anyUpdate) {
            delay = anyUpdate.arrival?.delay !== undefined ? anyUpdate.arrival.delay : anyUpdate.departure.delay;
          }
        }
      }

      const arrivalTime = scheduledTimeSec + delay;
      
      let routeShortName = getRouteShortName(tripInfo.routeId);
      const destination = tripInfo.headsign || 'Scheduled Route';

      // Clean route name (e.g. "1 15 c a" -> "15")
      if (routeShortName && routeShortName.length > 8 && routeShortName.includes(' ')) {
        const parts = routeShortName.split(' ');
        if (parts[1]) routeShortName = parts[1];
      }

      rawPredictions.push({
        route: routeShortName,
        destination: destination,
        arrivalTime: arrivalTime,
        live
      });
    }
  }

  // 2. Filter predictions (keep upcoming, allowing 1 minute grace)
  const filtered = rawPredictions.filter(p => p.arrivalTime >= nowSec - 60);

  // 3. Sort by arrival time ascending
  filtered.sort((a, b) => a.arrivalTime - b.arrivalTime);

  // 4. Group by route number and destination to separate directions
  const groups = new Map(); // route_destination -> { route, destination, arrivals: [] }
  
  for (const p of filtered) {
    const key = `${p.route}_${p.destination}`;
    if (!groups.has(key)) {
      groups.set(key, {
        route: p.route,
        destination: p.destination,
        arrivals: []
      });
    }

    const group = groups.get(key);
    // Limit to next 2 arrivals
    if (group.arrivals.length < 2) {
      const minsToArrive = Math.max(0, Math.round((p.arrivalTime - nowSec) / 60));
      group.arrivals.push(minsToArrive);
    }
  }

  return Array.from(groups.values());
}

/**
 * Stop polling (useful for clean shutdown or tests).
 */
export function stopRealtimePolling() {
  if (pollIntervalId) {
    clearTimeout(pollIntervalId);
    pollIntervalId = null;
  }
}

/**
 * Returns metadata about the real-time cache state.
 */
export function getRealtimeStatus() {
  return {
    mockMode: config.mockMode,
    lastFetchTime: lastFetchTime ? lastFetchTime.toISOString() : null,
    cacheSize: tripUpdatesCache.size
  };
}
