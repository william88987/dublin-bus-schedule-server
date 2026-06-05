import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import morgan from 'morgan';
import { createStream } from 'rotating-file-stream';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logDir = path.join(__dirname, '..', 'logs');

// Ensure log directory exists
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// Create rotating stream for access logs (daily rotation, keep 14 files)
const accessLogStream = createStream('access.log', {
  interval: '1d',
  path: logDir,
  maxFiles: 14
});

// Create rotating stream for error logs (daily rotation, keep 14 files)
const errorLogStream = createStream('error.log', {
  interval: '1d',
  path: logDir,
  maxFiles: 14
});

// Access logger middleware for file logging using standard Apache combined format
const fileAccessLogger = morgan('combined', { stream: accessLogStream });

/**
 * Custom request logging middleware.
 * - Logs standard Apache combined logs to logs/access.log (via morgan).
 * - Logs clean, timestamped requests with duration to standard console output.
 */
export const requestLogger = (req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress;
  const startTime = Date.now();

  // Hook into response end to capture duration and response status
  const originalEnd = res.end;
  res.end = function (...args) {
    const duration = Date.now() - startTime;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} - Status: ${res.statusCode} - IP: ${ip} - Duration: ${duration}ms`);
    originalEnd.apply(res, args);
  };

  // Write to the rolling file stream via morgan
  fileAccessLogger(req, res, next);
};

/**
 * Utility to log errors to logs/error.log with full stack traces and to standard console output.
 * @param {Error|string} error The error object or message to log.
 * @param {string} [context] Contextual label where the error occurred (e.g. 'GTFS-RT Polling').
 */
export function logError(error, context = '') {
  const timestamp = new Date().toISOString();
  const errorMessage = error instanceof Error ? error.stack : String(error);
  const logMessage = `[${timestamp}]${context ? ` [${context}]` : ''} ERROR: ${errorMessage}\n`;

  try {
    errorLogStream.write(logMessage);
  } catch (writeErr) {
    console.error('❌ Failed to write to error log file:', writeErr);
  }

  // Also print to console.error
  if (context) {
    console.error(`❌ [${context}]`, error);
  } else {
    console.error('❌', error);
  }
}
