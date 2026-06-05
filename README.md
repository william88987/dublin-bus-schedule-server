# Dublin Bus GTFS Proxy Server

A lightweight Node.js API server designed as a high-performance proxy for Dublin Bus realtime schedules, optimized for resource-constrained devices like ESP32 microcontrollers.

It fetches, decodes, and indexes the official National Transport Authority (NTA) GTFS-Realtime (GTFS-R) Protobuf feed in the background, serving clean and compact JSON responses instantly from an in-memory cache.

---

## Features

- **In-Memory Cache**: Serves arrival schedules in `< 5ms` without hammering NTA API limits on client queries.
- **Smart Stop Resolution**: Automatically maps 4-digit bus stop codes (e.g., `7347` printed on stop poles) to GTFS stop IDs (e.g., `8240DB007347`) used by the realtime feed.
- **IP Rate Limiting**: Built-in configurable rate limiting to protect the server from client flooding.
- **Mock Mode**: Runs out-of-the-box with a deterministic, real-time countdown scheduler if no NTA API Key is provided.
- **Zero Heavy Dependencies**: Uses pure JS parsing to extract only the required tables (`routes.txt`, `trips.txt`, `stops.txt`) directly from the 143MB GTFS ZIP, keeping memory footprint under 150MB.

---

## API Specification

### Endpoint: `GET /bus`

Fetches the next two arrivals for each route serving a bus stop.

#### Query Parameters

| Parameter | Type | Required | Description | Example |
| :--- | :--- | :--- | :--- | :--- |
| `stop` | String | Yes | Commuter stop code or GTFS stop ID. | `7347` |

#### Rate Limit Headers

The API includes draft-7 rate limiting headers:
- `RateLimit-Limit`: Maximum requests allowed per window.
- `RateLimit-Remaining`: Remaining requests.
- `RateLimit-Reset`: Seconds remaining in the current window.

#### Example Response (200 OK)

Returns upcoming arrival schedules grouped by route number. The arrival times are presented as an array of minutes to arrival (`arrivals`), sorted ascending (up to 2 elements).

```json
{
  "stop": "7347",
  "name": "Airport Zone 15",
  "timestamp": 1780678414,
  "schedules": [
    {
      "route": "39A",
      "destination": "UCD Belfield",
      "arrivals": [0, 12]
    },
    {
      "route": "15",
      "destination": "Clongriffin",
      "arrivals": [1, 9]
    }
  ]
}
```

#### Error Responses

- **400 Bad Request**: If the `stop` parameter is missing or empty.
- **429 Too Many Requests**: If the IP rate limit is exceeded.
- **503 Service Unavailable**: If queried during server initialization while static GTFS data is being parsed.

---

## Health Status Endpoint

### Endpoint: `GET /status`

Returns health metadata about the server, cache freshness, and memory consumption.

#### Example Response
```json
{
  "status": "online",
  "staticGtfsReady": true,
  "mockMode": true,
  "lastRealtimeFetch": "2026-06-05T16:52:04.386Z",
  "cachedStopsCount": 10213,
  "uptime": 13.015,
  "memory": {
    "rss": "435.0 MB",
    "heapUsed": "137.5 MB"
  }
}
```

---

## Configuration (`.env`)

Copy `.env.example` to `.env` and configure your settings:

```ini
PORT=3006
NTA_API_KEY=your_nta_api_key
MOCK_MODE=false
RT_FETCH_INTERVAL_SEC=30
STATIC_GTFS_ZIP_URL=https://www.transportforireland.ie/transitData/Data/GTFS_Realtime.zip
STATIC_REFRESH_INTERVAL_HOURS=24
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=60
```

*Note: If `NTA_API_KEY` is blank, the server will automatically default to `MOCK_MODE=true`.*

---

## Local Setup

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Run the server in development mode**:
   ```bash
   npm run dev
   ```

3. **Verify the server**:
   ```bash
   curl -i "http://localhost:3006/bus?stop=7347"
   ```

---

## Production Deployment Notes

1. **Reverse Proxy / SSL**: When deploying behind a reverse proxy (Nginx, Cloudflare, AWS ALB), make sure that Express is configured to trust proxy headers (already configured with `app.set('trust proxy', true)`). This ensures the rate limiter extracts the real client IP rather than the proxy IP.
2. **API Keys**: Register and obtain a subscription key from the [NTA Developer Portal](https://developer.nationaltransport.ie/) to use live feeds.
3. **RAM requirements**: Although unzipping the GTFS static files is optimized to process only routes and trips, Node.js needs around 150MB of RAM. A standard VPS with 512MB RAM is more than sufficient.
