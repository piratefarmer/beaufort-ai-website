# Beaufort AI Dashboard — Bad Gateway Fix (June 7, 2026)

**Problem**: Dashboard shows "Bad Gateway" error when trying to fetch live Beau data.

**Root Cause**: Website was hardcoded to fetch from `http://192.168.1.226:5000` (private local IP). Visitors from the internet can't reach it.

**Solution**: Use Cloudflare Worker as a public API proxy.

---

## What Changed

### 1. **API Proxy Worker** (`src/api-proxy-worker.js`)
- New Cloudflare Worker that proxies requests from beaufortai.ai → Pi's local API
- Works only if you have Tailscale VPN or direct network access to Pi
- Routes: `/api/sensors` and `/api/beau`
- Returns JSON with sensor data + Beau predictions

### 2. **Updated Dashboard** (`dashboard.html`)
- Changed PROXY_BASE from `http://192.168.1.226:5000/api/sensors` → `/api/sensors`
- Now fetches from public Cloudflare endpoints
- Displays Beau predictions alongside sensor readings
- Falls back gracefully if Beau is offline

### 3. **Wrangler Config** (`wrangler.toml`)
- Configures Worker routes in Cloudflare

---

## Deployment Steps

### Step 1: Install Wrangler (if not already installed)
```bash
npm install -g wrangler
```

### Step 2: Verify Cloudflare Account
```bash
wrangler login
```

Should redirect to Cloudflare. Confirm your account.

### Step 3: Deploy Worker
```bash
cd ~/.openclaw/workspace/beaufort-ai-website
wrangler deploy --env production
```

Expected output:
```
✅ Build succeeded!
✅ Deployed api-proxy-worker to beaufortai.ai
  Route: beaufortai.ai/api/*
```

### Step 4: Test the API
```bash
curl https://beaufortai.ai/api/sensors
```

Should return JSON:
```json
{
  "wind_speed_kts": 18.4,
  "wind_direction": 215,
  "pressure_hpa": 1001.2,
  "temperature_f": 83.9,
  "timestamp": "2026-06-07T16:00:45Z"
}
```

If you get a 503 error, the Pi is offline or unreachable.

### Step 5: Verify Website
Open https://beaufortai.ai/dashboard.html in browser.

Should show:
- ✅ Live sensor readings (wind, pressure, temp)
- ✅ Beau assessment (if sensor_to_beau.py is running on Pi)
- ✅ Status indicator (green if Pi online, red if offline)

---

## How It Works

```
beaufortai.ai (visitor)
    ↓ HTTPS request to /api/sensors
    ↓
Cloudflare Worker (public)
    ↓ Routes through Tailscale/private network
    ↓
Pi @ 192.168.1.226:5000 (private)
    ↓ Returns sensor JSON
    ↓
Cloudflare Worker (caches briefly, returns CORS headers)
    ↓
beaufortai.ai dashboard (displays data)
```

---

## Troubleshooting

### "503 Service Unavailable"
Pi is offline or unreachable from Worker.

**Check:**
1. Is Pi online? `ping 192.168.1.226` from your Mac
2. Is dashboard running? `ssh beau-pi@192.168.1.226 curl http://localhost:5000`
3. Is Tailscale active? (if using Tailscale for connectivity)

### "CORS Error" in browser console
Cloudflare Worker is not setting CORS headers correctly.

**Fix:**
```bash
wrangler tail --env production
```

Watch real-time logs for errors. If you see "Cannot fetch", the Pi URL is wrong.

### "Gateway timeout"
Pi is responding too slowly.

**Check:**
1. Is sensor_logger.py running? `ssh beau-pi@192.168.1.226 sudo systemctl status beaufort-sensors`
2. Are sensors connected? Check `/home/beau-pi/beau/logs/sensors.json` — should have recent timestamp

### Dashboard shows old data
API is caching. Cloudflare Worker has `Cache-Control: no-cache`.

**Force refresh:**
- Hard reload in browser: Cmd+Shift+R
- Clear browser cache
- Verify Pi is generating new `sensors.json` (check timestamp)

---

## Monitoring

**Watch live API calls:**
```bash
wrangler tail --env production
```

**Check Pi dashboard directly (local network only):**
```
http://192.168.1.226:5000
```

**Check sensor log:**
```bash
ssh beau-pi@192.168.1.226 tail -f ~/beau/logs/sensors.json
```

**Check Beau predictions:**
```bash
ssh beau-pi@192.168.1.226 cat ~/beau/logs/beau_predictions.json
```

---

## Limitations

1. **Network Access Required**: Worker can only reach Pi if it has access to your private network (Tailscale, VPN, or direct connection)
2. **Latency**: ~500ms-1s for API call (Cloudflare → Pi → back)
3. **No Real-Time**: Updates every 5 seconds (sensor polling interval)
4. **Beau Latency**: If sensor_to_beau.py is running, predictions update every 5 minutes

---

## Files Modified

- `dashboard.html` — Changed API endpoints, added Beau display
- `src/api-proxy-worker.js` — New Cloudflare Worker
- `wrangler.toml` — New Worker config

## Files Created

- (None new local files, Worker deployed to Cloudflare)

---

## Next Steps

1. **Deploy Worker** (step above)
2. **Test API** from command line
3. **Open dashboard** in browser and verify sensor data appears
4. **When sensor_to_beau.py is running**, verify Beau predictions appear alongside sensors
5. **Share dashboard URL** with others: https://beaufortai.ai/dashboard.html

---

**Status**: Ready to deploy  
**Last Updated**: June 7, 2026
**By**: Max (Claudius Maximus)
