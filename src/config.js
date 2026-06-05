import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load environment variables
dotenv.config();

// Bypass TLS verification by default to prevent certificate chain errors on local development hosts
if (process.env.BYPASS_TLS !== 'false') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const config = {
  port: parseInt(process.env.PORT, 10) || 3006,
  ntaApiKey: process.env.NTA_API_KEY || '',
  rtFetchIntervalSec: parseInt(process.env.RT_FETCH_INTERVAL_SEC, 10) || 30,
  staticGtfsZipUrl: process.env.STATIC_GTFS_ZIP_URL || 'https://www.transportforireland.ie/transitData/Data/GTFS_Realtime.zip',
  staticRefreshIntervalHours: parseInt(process.env.STATIC_REFRESH_INTERVAL_HOURS, 10) || 24,
  rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60000, // 1 minute
  rateLimitMaxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10) || 60, // 60 requests per minute
  dataDir: path.join(__dirname, '..', 'data'),
  mockMode: process.env.MOCK_MODE === 'true'
};

// Auto-enable mock mode if no API key is specified
if (!config.ntaApiKey && !config.mockMode) {
  console.warn('⚠️ WARNING: NTA_API_KEY is not set. Automatically enabling MOCK_MODE=true for local testing.');
  config.mockMode = true;
}

export default config;
