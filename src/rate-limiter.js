import rateLimit from 'express-rate-limit';
import config from './config.js';

// Define the rate limiting middleware
const limiter = rateLimit({
  windowMs: config.rateLimitWindowMs,
  max: config.rateLimitMaxRequests,
  standardHeaders: 'draft-7', // Return standard RateLimit-* headers
  legacyHeaders: false,        // Disable the X-RateLimit-* headers
  message: {
    status: 429,
    error: 'Too Many Requests',
    message: `API rate limit exceeded. You are limited to ${config.rateLimitMaxRequests} requests per ${config.rateLimitWindowMs / 1000} seconds.`
  },
  handler: (req, res, next, options) => {
    console.warn(`⚠️ Rate limit triggered for IP: ${req.ip} calling ${req.originalUrl}`);
    res.status(options.statusCode).json(options.message);
  },
  keyGenerator: (req) => {
    // Use req.ip (requires app.set('trust proxy', true) in server.js if running behind a reverse proxy like Nginx or Cloudflare)
    return req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  }
});

export default limiter;
