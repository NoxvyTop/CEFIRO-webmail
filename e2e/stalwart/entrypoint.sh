#!/bin/sh
set -e
# Seed the (empty) volumes from the baked provisioned state on first boot.
if [ ! -f /etc/stalwart/config.json ]; then
  cp -a /seed/etc/. /etc/stalwart/
fi
if [ ! -f /var/lib/stalwart/CURRENT ]; then
  cp -a /seed/data/. /var/lib/stalwart/
  rm -f /var/lib/stalwart/LOCK
fi
exec /usr/local/bin/stalwart --config /etc/stalwart/config.json
