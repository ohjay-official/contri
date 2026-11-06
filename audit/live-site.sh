#!/usr/bin/env bash
# Read-only look at the live site: headers and bodies of every page and route.
set -u
D=${1:-https://contri.ng}; O=${2:-out/live}; mkdir -p "$O/bodies"
for p in / /how-it-works /privacy /terms /app /join /no-such-page /api/config "/api/config?check=limits" /robots.txt /sitemap.xml /manifest.webmanifest /favicon.svg /og.png /css/contri.css /js/site.js "/www-check"; do
  f=$(echo "$p" | tr '/?=&' '____'); 
  { echo "### GET $D$p"; curl -sS -D - -o "$O/bodies/$f" -w '\n(status %{http_code}, %{size_download} bytes, %{time_total}s)\n' "$D$p"; echo; } >> "$O/headers.txt" 2>&1
done
{ echo "### http -> https"; curl -sSI "http://contri.ng/" | head -5; echo "### www"; curl -sSI "https://www.contri.ng/" | head -8; } >> "$O/headers.txt" 2>&1
{ echo "### TLS"; echo | openssl s_client -connect contri.ng:443 -servername contri.ng 2>/dev/null | openssl x509 -noout -issuer -subject -dates; } >> "$O/headers.txt" 2>&1
