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
    *)
        echo "Usage: $0 {start|stop|restart|status|logs|delete|monit}"
        echo "  start   - Add and start the app in PM2"
        echo "  stop    - Stop the running app"
        echo "  restart - Restart the app"
        echo "  status  - Show status and details"
        echo "  logs    - View real-time logs"
        echo "  delete  - Delete the app from PM2 registry"
        echo "  monit   - Launch PM2 terminal dashboard"
        exit 1
        ;;
esac
