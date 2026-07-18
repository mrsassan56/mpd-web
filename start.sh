#!/bin/bash
# Manual start (systemd service is preferred): ./start.sh
cd "$(dirname "$0")"
exec ./venv/bin/python3 app.py
