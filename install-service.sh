#!/bin/bash
# Install or update mpd-web systemd service on the Pi.
set -e
cd "$(dirname "$0")"

echo "Installing mpd-web service..."
cp mpd-web.service /etc/systemd/system/mpd-web.service
systemctl daemon-reload
systemctl enable mpd-web.service
systemctl restart mpd-web.service
sleep 2
systemctl status mpd-web.service --no-pager
echo ""
echo "Web UI: http://192.168.9.232:5000/"
