# Verify token-traffic

Token Traffic - LLM serving simulator (prefill/decode/KV cache).

## Launch
Serve the repo root over plain HTTP and load it in a real browser; everything is static.

```bash
python3 -m http.server 8137 --bind 127.0.0.1
```

## Doctor
`python3 .cursor/skills/verify-token-traffic/verify.py` - exits non-zero and lists failures when anything regresses.

## Drive
The runner serves the app, drives it with headless Chromium, and asserts the boot marker plus zero JS console errors.

## Evidence
Latest run is written to `.cursor/skills/verify-token-traffic/evidence.json` (failures list; empty means green).

## Cleanup
The runner leaves no daemons or state; the HTTP server is terminated after the render.

## Known boundaries
External-network-dependent content is neutralized during verification via host-resolver rules; the check proves local boot, not third-party services.
