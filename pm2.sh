#!/bin/bash

# Configuration
APP_NAME="dublin-bus-proxy"
ENTRY_POINT="src/server.js"

# Check if pm2 is installed locally/globally
if ! command -v pm2 &> /dev/null; then
    echo "⚠️ PM2 is not installed. You can install it globally via: npm install -g pm2"
    exit 1
fi

case "$1" in
    start)
        echo "🚀 Starting $APP_NAME in PM2..."
        pm2 start $ENTRY_POINT --name "$APP_NAME" --update-env
        ;;
    stop)
        echo "🛑 Stopping $APP_NAME in PM2..."
        pm2 stop "$APP_NAME"
        ;;
    restart)
        echo "🔄 Restarting $APP_NAME in PM2..."
        pm2 restart "$APP_NAME"
        ;;
    status)
        echo "📊 PM2 Status for $APP_NAME:"
        pm2 show "$APP_NAME" || pm2 status
        ;;
    logs)
        echo "📋 Showing logs for $APP_NAME (Ctrl+C to exit):"
        pm2 logs "$APP_NAME"
        ;;
    delete)
        echo "🗑️ Deleting $APP_NAME from PM2..."
        pm2 delete "$APP_NAME"
        ;;
    monit)
        echo "🖥️ Starting PM2 monitor..."
        pm2 monit
        ;;
    test-static)
        echo "🧹 Clearing existing GTFS cache to force re-download..."
        rm -f data/GTFS_Realtime.zip data/gtfs.db
        echo "📥 Running static GTFS download & unzip test directly..."
        node -e "import('./src/gtfs-static.js').then(m => m.loadStaticGtfs())"
        ;;
    refresh-data)
        echo "🧹 Clearing existing GTFS cache..."
        rm -f data/GTFS_Realtime.zip data/gtfs.db
        echo "🔄 Restarting $APP_NAME in PM2..."
        pm2 restart "$APP_NAME"
        echo "📋 Streaming logs (Ctrl+C to exit):"
        pm2 logs "$APP_NAME" --lines 30
        ;;
    health)
        echo "🩺 Fetching server & static data status:"
        if command -v jq &> /dev/null; then
            curl -s http://localhost:3006/status | jq .
        elif command -v json_pp &> /dev/null; then
            curl -s http://localhost:3006/status | json_pp
        else
            curl -s http://localhost:3006/status
            echo ""
        fi
        ;;
    *)
        echo "Usage: $0 {start|stop|restart|status|logs|delete|monit|test-static|refresh-data|health}"
        echo "  start        - Add and start the app in PM2"
        echo "  stop         - Stop the running app"
        echo "  restart      - Restart the app"
        echo "  status       - Show status and details"
        echo "  logs         - View real-time logs"
        echo "  delete       - Delete the app from PM2 registry"
        echo "  monit        - Launch PM2 terminal dashboard"
        echo "  test-static  - Clear cache and test download/unzip in the terminal"
        echo "  refresh-data - Clear cache, restart PM2, and tail startup logs"
        echo "  health       - Check /status endpoint (shows GTFS download status)"
        exit 1
        ;;
esac
