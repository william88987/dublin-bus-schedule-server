import express from 'express';
import config from './config.js';
import limiter from './rate-limiter.js';
import { loadStaticGtfs, isStaticGtfsReady, getStopName, resolveStopId } from './gtfs-static.js';
import { startRealtimePolling, getPredictionsForStop, getRealtimeStatus } from './gtfs-realtime.js';

const app = express();

// Trust reverse proxy headers (crucial for accurate IP rate limiting in cloud environments like Heroku, Render, AWS ALB, Nginx)
app.set('trust proxy', true);

// Standard JSON body parser
app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress;
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} - IP: ${ip}`);
  next();
});

/**
 * Health and status endpoint
 */
app.get('/status', (req, res) => {
  const rtStatus = getRealtimeStatus();
  
  res.json({
    status: 'online',
    staticGtfsReady: isStaticGtfsReady(),
    mockMode: rtStatus.mockMode,
    lastRealtimeFetch: rtStatus.lastFetchTime,
    cachedStopsCount: rtStatus.cacheSize,
    uptime: process.uptime(),
    memory: {
      rss: `${(process.memoryUsage().rss / 1024 / 1024).toFixed(1)} MB`,
      heapUsed: `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)} MB`
    }
  });
});

/**
 * Primary Dublin Bus arrivals endpoint
 * GET /bus?stop=XXXX
 */
app.get('/bus', limiter, (req, res) => {
  // 1. Guard: Check if static GTFS is fully loaded
  if (!isStaticGtfsReady()) {
    return res.status(503).json({
      status: 503,
      error: 'Service Unavailable',
      message: 'Server is initializing static transit schedules. Please retry in a few seconds.'
    });
  }

  // 2. Validate request parameter
  const stopId = req.query.stop;
  if (!stopId || typeof stopId !== 'string' || stopId.trim() === '') {
    return res.status(400).json({
      status: 400,
      error: 'Bad Request',
      message: "Query parameter 'stop' is required. Example: /bus?stop=7347"
    });
  }

  const cleanStopId = stopId.trim();
  const officialStopId = resolveStopId(cleanStopId);
  const stopName = getStopName(officialStopId);

  try {
    // 3. Retrieve predictions
    const schedules = getPredictionsForStop(cleanStopId);
    
    // 4. Return results
    res.json({
      stop: cleanStopId,
      name: stopName,
      timestamp: Math.floor(Date.now() / 1000),
      schedules: schedules
    });
  } catch (error) {
    console.error(`❌ Error handling predictions for stop ${cleanStopId}:`, error);
    res.status(500).json({
      status: 500,
      error: 'Internal Server Error',
      message: 'An error occurred while retrieving real-time schedule information.'
    });
  }
});

/**
 * Endpoint to manually trigger a static GTFS download and refresh
 */
app.post('/refresh-static', async (req, res) => {
  console.log('🔄 Manual static GTFS refresh triggered via POST /refresh-static');
  
  // Basic security: if NTA_API_KEY is configured, expect a header or query parameter for authorization
  if (config.ntaApiKey) {
    const authHeader = req.headers['authorization'] || req.headers['x-api-key'];
    if (authHeader !== config.ntaApiKey) {
      return res.status(401).json({ status: 401, error: 'Unauthorized', message: 'Invalid credentials.' });
    }
  }

  try {
    // Trigger download in background to not block the request
    loadStaticGtfs()
      .then(() => {
        // If not in mock mode, restart realtime polling to bind to new static tables
        if (!config.mockMode) {
          startRealtimePolling();
        }
      })
      .catch(err => {
        console.error('❌ Background static GTFS reload failed:', err);
      });

    res.json({
      status: 'accepted',
      message: 'Static GTFS download and parse initiated in background.'
    });
  } catch (error) {
    res.status(500).json({
      status: 500,
      error: 'Internal Server Error',
      message: error.message
    });
  }
});

// Fallback 404 handler
app.use((req, res) => {
  res.status(404).json({
    status: 404,
    error: 'Not Found',
    message: `Endpoint ${req.method} ${req.url} does not exist.`
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('❌ Unhandled Exception:', err);
  res.status(500).json({
    status: 500,
    error: 'Internal Server Error',
    message: 'An unexpected error occurred on the server.'
  });
});

// Start the server
async function bootstrap() {
  try {
    console.log('🚀 Starting Dublin Bus GTFS Proxy Server...');
    
    // Load static data first
    await loadStaticGtfs();
    
    // Start periodic realtime updates
    startRealtimePolling();
    
    // Schedule periodic static GTFS updates (default: every 24 hours)
    setInterval(async () => {
      console.log('⏰ Scheduled static GTFS refresh check...');
      try {
        await loadStaticGtfs();
        if (!config.mockMode) {
          startRealtimePolling();
        }
      } catch (err) {
        console.error('❌ Scheduled static GTFS refresh failed:', err);
      }
    }, config.staticRefreshIntervalHours * 60 * 60 * 1000);
    
    app.listen(config.port, () => {
      console.log(`📡 Server listening on port ${config.port}`);
      console.log(`📍 Endpoint URL: http://localhost:${config.port}/bus?stop=7347`);
      console.log(`🩺 Health status: http://localhost:${config.port}/status`);
      if (config.mockMode) {
        console.log('💡 Mock mode enabled. No NTA API key needed. Try querying any stop ID!');
      }
    });
  } catch (error) {
    console.error('❌ Critical startup failure:', error);
    process.exit(1);
  }
}

bootstrap();
