import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import { DatabaseSync } from 'node:sqlite';
import { execSync } from 'child_process';
import readline from 'readline';
import config from './config.js';
import { logError } from './logger.js';

// In-memory GTFS Static caches
let routesMap = new Map(); // route_id -> route_short_name (bus number)
let tripsMap = new Map();  // trip_id -> { routeId, headsign }
let stopsMap = new Map();  // stop_id -> stop_name
let stopCodeToIdMap = new Map(); // stop_code -> stop_id
let calendarData = []; // list of calendar entries
let calendarDatesData = []; // list of calendar exceptions
let isLoaded = false;
let isLoading = false;

// SQLite Database resources
let dbInstance = null;
let queryStmt = null;

/**
 * Simple CSV parser that handles double quotes and commas within quotes.
 */
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

/**
 * Downloads the static GTFS zip if it doesn't exist or is older than configured refresh interval.
 * Returns true if a new file was downloaded.
 */
async function ensureStaticGtfsFile() {
  const zipPath = path.join(config.dataDir, 'GTFS_Realtime.zip');
  
  if (!fs.existsSync(config.dataDir)) {
    fs.mkdirSync(config.dataDir, { recursive: true });
  }

  let downloadNeeded = true;

  if (fs.existsSync(zipPath)) {
    const stats = fs.statSync(zipPath);
    const ageInHours = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60);
    console.log(`ℹ️ Static GTFS file exists. Age: ${ageInHours.toFixed(1)} hours.`);
    
    if (ageInHours < config.staticRefreshIntervalHours) {
      downloadNeeded = false;
      console.log('ℹ️ Static GTFS file is fresh. Skipping download.');
    } else {
      console.log(`ℹ️ Static GTFS file is older than ${config.staticRefreshIntervalHours} hours. Refreshing...`);
    }
  }

  if (downloadNeeded) {
    console.log(`📥 Downloading static GTFS from ${config.staticGtfsZipUrl}...`);
    const startTime = Date.now();
    try {
      const response = await fetch(config.staticGtfsZipUrl);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const buffer = await response.arrayBuffer();
      fs.writeFileSync(zipPath, Buffer.from(buffer));
      console.log(`✅ Downloaded static GTFS ZIP in ${((Date.now() - startTime) / 1000).toFixed(1)}s (${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB)`);
      return true; // New download occurred
    } catch (error) {
      logError(error, 'Failed to download static GTFS. Will attempt to use existing file if available.');
      if (!fs.existsSync(zipPath)) {
        throw new Error('No static GTFS zip file found, and download failed.');
      }
    }
  }
  return false;
}

/**
 * Rebuilds the SQLite database from stop_times.txt in the ZIP file.
 */
async function rebuildSqliteDb() {
  const dbPath = path.join(config.dataDir, 'gtfs.db');
  const txtPath = path.join(config.dataDir, 'stop_times.txt');
  const zipPath = path.join(config.dataDir, 'GTFS_Realtime.zip');

  console.log('⏳ Rebuilding SQLite database from stop_times.txt (this will take ~15s)...');
  const startTime = Date.now();

  // Close active connection if any
  if (dbInstance) {
    dbInstance = null;
    queryStmt = null;
  }

  if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
  }

  // 1. Extract stop_times.txt from ZIP (OS command is extremely fast and memory-efficient)
  try {
    execSync(`unzip -p "${zipPath}" stop_times.txt > "${txtPath}"`);
  } catch (err) {
    logError(err, 'Failed to extract stop_times.txt from ZIP. Attempting JS fallback...');
    // JS Fallback (might use more RAM)
    const zip = new AdmZip(zipPath);
    const entry = zip.getEntry('stop_times.txt');
    if (!entry) throw new Error('stop_times.txt not found in ZIP');
    fs.writeFileSync(txtPath, entry.getData());
  }

  // 2. Open SQLite and configure optimizations
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA synchronous = OFF;');
  db.exec('PRAGMA journal_mode = OFF;');
  db.exec('PRAGMA cache_size = 100000;'); // ~100MB cache size

  db.exec(`
    CREATE TABLE stop_times (
      trip_id TEXT,
      arrival_time TEXT,
      stop_id TEXT
    )
  `);

  const insertStmt = db.prepare('INSERT INTO stop_times (trip_id, arrival_time, stop_id) VALUES (?, ?, ?)');
  
  const fileStream = fs.createReadStream(txtPath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  let lineCount = 0;
  let batchCount = 0;
  
  db.exec('BEGIN TRANSACTION;');
  
  for await (const line of rl) {
    if (lineCount === 0) {
      lineCount++;
      continue; // Skip header
    }
    
    const parts = line.split(',');
    if (parts.length >= 4) {
      insertStmt.run(parts[0], parts[1], parts[3]);
      batchCount++;
      
      if (batchCount >= 100000) {
        db.exec('COMMIT;');
        db.exec('BEGIN TRANSACTION;');
        batchCount = 0;
      }
    }
    lineCount++;
  }
  
  db.exec('COMMIT;');
  
  // Create index to make lookups virtually instant (0ms)
  db.exec('CREATE INDEX idx_stop_times ON stop_times (stop_id, trip_id)');

  // Clean up
  fs.unlinkSync(txtPath);
  
  console.log(`✅ SQLite database populated with ${lineCount} rows in ${((Date.now() - startTime) / 1000).toFixed(1)}s.`);
}

/**
 * Loads routes, trips, and stops from the static GTFS ZIP into memory.
 */
export async function loadStaticGtfs() {
  if (isLoading) return;
  isLoading = true;

  try {
    const downloadedNew = await ensureStaticGtfsFile();
    const zipPath = path.join(config.dataDir, 'GTFS_Realtime.zip');
    const dbPath = path.join(config.dataDir, 'gtfs.db');
    
    console.log('📂 Parsing static GTFS ZIP files...');
    const parseStartTime = Date.now();
    const zip = new AdmZip(zipPath);

    // 1. Parse routes.txt (small ~20KB)
    console.log('Parsing routes.txt...');
    const routesEntry = zip.getEntry('routes.txt');
    if (!routesEntry) throw new Error('routes.txt not found in GTFS zip');
    const routesText = routesEntry.getData().toString('utf8');
    const routesLines = routesText.replace(/\r/g, '').split('\n').filter(line => line.trim().length > 0);
    
    const routesHeaders = parseCSVLine(routesLines[0]);
    const routeIdIdx = routesHeaders.indexOf('route_id');
    const routeShortNameIdx = routesHeaders.indexOf('route_short_name');
    
    const newRoutesMap = new Map();
    for (let i = 1; i < routesLines.length; i++) {
      const parts = parseCSVLine(routesLines[i]);
      if (parts.length > Math.max(routeIdIdx, routeShortNameIdx)) {
        newRoutesMap.set(parts[routeIdIdx], parts[routeShortNameIdx]);
      }
    }

    // 2. Parse stops.txt (small ~600KB)
    console.log('Parsing stops.txt...');
    const stopsEntry = zip.getEntry('stops.txt');
    if (!stopsEntry) throw new Error('stops.txt not found in GTFS zip');
    const stopsText = stopsEntry.getData().toString('utf8');
    const stopsLines = stopsText.replace(/\r/g, '').split('\n').filter(line => line.trim().length > 0);
    
    const stopsHeaders = parseCSVLine(stopsLines[0]);
    const stopIdIdx = stopsHeaders.indexOf('stop_id');
    const stopCodeIdx = stopsHeaders.indexOf('stop_code');
    const stopNameIdx = stopsHeaders.indexOf('stop_name');
    
    const newStopsMap = new Map();
    const newStopCodeToIdMap = new Map();
    for (let i = 1; i < stopsLines.length; i++) {
      const parts = parseCSVLine(stopsLines[i]);
      if (parts.length > Math.max(stopIdIdx, stopCodeIdx, stopNameIdx)) {
        const stopId = parts[stopIdIdx];
        const stopCode = parts[stopCodeIdx];
        const stopName = parts[stopNameIdx];
        
        newStopsMap.set(stopId, stopName);
        if (stopCode) {
          newStopCodeToIdMap.set(stopCode, stopId);
        }
      }
    }

    // 3. Parse calendar.txt (small ~5KB)
    console.log('Parsing calendar.txt...');
    const calendarEntry = zip.getEntry('calendar.txt');
    const newCalendarData = [];
    if (calendarEntry) {
      const calendarText = calendarEntry.getData().toString('utf8');
      const calendarLines = calendarText.replace(/\r/g, '').split('\n').filter(line => line.trim().length > 0);
      const calendarHeaders = parseCSVLine(calendarLines[0]);
      for (let i = 1; i < calendarLines.length; i++) {
        const parts = parseCSVLine(calendarLines[i]);
        if (parts.length >= calendarHeaders.length) {
          const entry = {};
          for (let j = 0; j < calendarHeaders.length; j++) {
            entry[calendarHeaders[j]] = parts[j];
          }
          newCalendarData.push(entry);
        }
      }
    }

    // 4. Parse calendar_dates.txt (small ~3KB)
    console.log('Parsing calendar_dates.txt...');
    const calendarDatesEntry = zip.getEntry('calendar_dates.txt');
    const newCalendarDatesData = [];
    if (calendarDatesEntry) {
      const calendarDatesText = calendarDatesEntry.getData().toString('utf8');
      const calendarDatesLines = calendarDatesText.replace(/\r/g, '').split('\n').filter(line => line.trim().length > 0);
      const calendarDatesHeaders = parseCSVLine(calendarDatesLines[0]);
      for (let i = 1; i < calendarDatesLines.length; i++) {
        const parts = parseCSVLine(calendarDatesLines[i]);
        if (parts.length >= calendarDatesHeaders.length) {
          const entry = {};
          for (let j = 0; j < calendarDatesHeaders.length; j++) {
            entry[calendarDatesHeaders[j]] = parts[j];
          }
          newCalendarDatesData.push(entry);
        }
      }
    }

    // 5. Parse trips.txt (~22MB, ~275k records)
    console.log('Parsing trips.txt...');
    const tripsEntry = zip.getEntry('trips.txt');
    if (!tripsEntry) throw new Error('trips.txt not found in GTFS zip');
    const tripsText = tripsEntry.getData().toString('utf8');
    const tripsLines = tripsText.replace(/\r/g, '').split('\n').filter(line => line.trim().length > 0);
    
    const tripsHeaders = parseCSVLine(tripsLines[0]);
    const tripIdIdx = tripsHeaders.indexOf('trip_id');
    const tripRouteIdIdx = tripsHeaders.indexOf('route_id');
    const tripHeadsignIdx = tripsHeaders.indexOf('trip_headsign');
    const tripServiceIdIdx = tripsHeaders.indexOf('service_id');
    
    const newTripsMap = new Map();
    for (let i = 1; i < tripsLines.length; i++) {
      const parts = parseCSVLine(tripsLines[i]);
      if (parts.length > Math.max(tripIdIdx, tripRouteIdIdx, tripHeadsignIdx, tripServiceIdIdx)) {
        newTripsMap.set(parts[tripIdIdx], {
          routeId: parts[tripRouteIdIdx],
          headsign: parts[tripHeadsignIdx],
          serviceId: parts[tripServiceIdIdx]
        });
      }
    }

    // 6. Ensure SQLite database is present and fresh
    const dbExists = fs.existsSync(dbPath);
    if (!dbExists || downloadedNew) {
      await rebuildSqliteDb();
    } else {
      console.log('ℹ️ SQLite database is present and fresh. Skipping rebuild.');
    }

    // Initialize Database lookup statement
    dbInstance = new DatabaseSync(dbPath);
    queryStmt = dbInstance.prepare('SELECT arrival_time FROM stop_times WHERE stop_id = ? AND trip_id = ? LIMIT 1');

    // Atomically swap the caches to ensure zero-downtime serving
    routesMap = newRoutesMap;
    stopsMap = newStopsMap;
    stopCodeToIdMap = newStopCodeToIdMap;
    tripsMap = newTripsMap;
    calendarData = newCalendarData;
    calendarDatesData = newCalendarDatesData;
    
    isLoaded = true;
    console.log(`✅ Loaded static GTFS in ${((Date.now() - parseStartTime) / 1000).toFixed(1)}s.`);
    console.log(`   - Routes: ${routesMap.size}`);
    console.log(`   - Trips: ${tripsMap.size}`);
    console.log(`   - Stops: ${stopsMap.size}`);
    console.log(`   - Stop Code Mappings: ${stopCodeToIdMap.size}`);
    
    // Print memory usage for verification
    const mem = process.memoryUsage();
    console.log(`   - RAM Heap Used: ${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB / Max Limit: ${(mem.heapTotal / 1024 / 1024).toFixed(1)} MB`);
  } catch (error) {
    logError(error, 'Error loading static GTFS');
    throw error;
  } finally {
    isLoading = false;
  }
}

/**
 * Helper to get the day of the week name for a date string (YYYYMMDD).
 */
function getDayOfWeek(dateStr) {
  const year = parseInt(dateStr.substring(0, 4), 10);
  const month = parseInt(dateStr.substring(4, 6), 10) - 1;
  const day = parseInt(dateStr.substring(6, 8), 10);
  const date = new Date(year, month, day);
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  return days[date.getDay()];
}

/**
 * Returns a Set of active service IDs for a given date string (YYYYMMDD).
 */
export function getActiveServiceIds(dateStr) {
  const dayOfWeek = getDayOfWeek(dateStr);
  const activeServices = new Set();
  
  for (const row of calendarData) {
    if (row.start_date <= dateStr && dateStr <= row.end_date) {
      if (row[dayOfWeek] === '1') {
        activeServices.add(row.service_id);
      }
    }
  }
  
  for (const row of calendarDatesData) {
    if (row.date === dateStr) {
      if (row.exception_type === '1') {
        activeServices.add(row.service_id);
      } else if (row.exception_type === '2') {
        activeServices.delete(row.service_id);
      }
    }
  }
  
  return activeServices;
}

/**
 * Queries the SQLite database for a trip's scheduled arrival time at a stop.
 */
export function getScheduledArrivalTime(tripId, stopId) {
  if (!queryStmt) return null;
  try {
    const row = queryStmt.get(stopId, tripId);
    return row ? row.arrival_time : null;
  } catch (err) {
    logError(err, `SQLite scheduled time lookup failed (Trip: ${tripId}, Stop: ${stopId})`);
    return null;
  }
}

/**
 * Returns the short name (bus number) for a route ID.
 */
export function getRouteShortName(routeId) {
  return routesMap.get(routeId) || routeId;
}

/**
 * Returns the trip details (routeId, headsign/destination) for a trip ID.
 */
export function getTripInfo(tripId) {
  return tripsMap.get(tripId);
}

/**
 * Returns the stop name for a stop ID.
 */
export function getStopName(stopId) {
  return stopsMap.get(stopId) || 'Unknown Stop';
}

/**
 * Resolves a stop code (e.g. "7347") or stop ID to the official stop ID.
 */
export function resolveStopId(stopCodeOrId) {
  return stopCodeToIdMap.get(stopCodeOrId) || stopCodeOrId;
}

/**
 * Check if the static GTFS is loaded.
 */
export function isStaticGtfsReady() {
  return isLoaded;
}

let queryTripsStmt = null;

/**
 * Returns scheduled trips for a stop ID arriving after a specific time (HH:MM:SS) in ASC order.
 */
export function getScheduledTripsForStop(stopId, afterTimeStr) {
  if (!dbInstance) return [];
  if (!queryTripsStmt) {
    queryTripsStmt = dbInstance.prepare(`
      SELECT trip_id, arrival_time 
      FROM stop_times 
      WHERE stop_id = ? AND arrival_time >= ? 
      ORDER BY arrival_time ASC 
      LIMIT 500
    `);
  }
  try {
    return queryTripsStmt.all(stopId, afterTimeStr);
  } catch (err) {
    logError(err, `SQLite scheduled trips lookup failed (Stop: ${stopId}, Time: ${afterTimeStr})`);
    return [];
  }
}
