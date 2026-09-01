#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

FAILURES_FILE="download-failures.txt"
rm -f "$FAILURES_FILE"

download_file() {
    local url="$1"
    local dest="$2"
    local dest_dir="$(dirname "$dest")"
    
    mkdir -p "$dest_dir"
    
    echo "Downloading: $url -> $dest"
    
    if curl -L -f -s -S --max-time 120 -o "$dest" "$url" 2>&1; then
        echo "  ✓ Success"
        return 0
    else
        local status=$?
        echo "  ✗ Failed (exit code: $status)"
        echo "$url -> $dest (exit code: $status)" >> "$FAILURES_FILE"
        return 1
    fi
}

echo "=== Downloading files from manifest.json ==="
echo

jq -r '.[] | "\(.url)\t\(.dest)"' manifest.json | while IFS=$'\t' read -r url dest; do
    download_file "$url" "$dest" || true
    sleep 0.5
done

echo
echo "=== Downloading files from manifest-extended.json ==="
echo

jq -r '.[] | "\(.url)\t\(.dest)"' manifest-extended.json | while IFS=$'\t' read -r url dest; do
    download_file "$url" "$dest" || true
    sleep 0.5
done

echo
echo "=== Download complete ==="
if [ -f "$FAILURES_FILE" ]; then
    echo
    echo "⚠️  Some downloads failed. See $FAILURES_FILE for details:"
    cat "$FAILURES_FILE"
else
    echo "✓ All downloads successful"
fi
