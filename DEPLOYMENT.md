# Meet Assistant - Deployment Guide

## Quick Start

This guide walks you through deploying Meet Assistant to Vercel with GitHub.

### Prerequisites
- GitHub account (free)
- Vercel account (free)
- OpenAI API key (from Keychain or environment)

---

## Step 1: Push to GitHub

### 1.1 Create GitHub Repository
1. Go to https://github.com/new
2. Repository name: `meet-assistant`
3. Description: "Chrome extension + Node.js server for Google Meet transcription"
4. Select: **Public** (required for Vercel)
5. DO NOT initialize with README/gitignore/license
6. Click "Create repository"

### 1.2 Push Code

Run in your terminal:

```bash
cd "/Users/juaneszepeda/meet asistanrt"

# Add GitHub as remote (replace YOUR_USERNAME)
git remote add origin https://github.com/YOUR_USERNAME/meet-assistant.git
git branch -M main
git push -u origin main
```

### 1.3 Verify
Open: https://github.com/YOUR_USERNAME/meet-assistant

You should see all files listed.

---

## Step 2: Deploy to Vercel

### 2.1 Connect Repository
1. Go to https://vercel.com
2. Sign in (or create free account)
3. Click **"New Project"**
4. Click **"Import Git Repository"**
5. Paste your GitHub URL: `https://github.com/YOUR_USERNAME/meet-assistant`
6. Click **"Import"**

### 2.2 Configure Environment Variables
1. In the "Environment Variables" section, add:
   - **Name:** `OPENAI_API_KEY`
   - **Value:** _(paste your OpenAI API key)_
   - **Name:** `API_KEY`
   - **Value:** _(generate a random secret, e.g. `openssl rand -hex 32`)_
2. Make sure both are set for all environments (Production, Preview, Development)

> **Security:** The `API_KEY` protects your server from unauthorized access. Without it, anyone with your Vercel URL can use your OpenAI credits.

### 2.3 Configure Build Settings
- **Framework Preset:** Node.js
- **Build Command:** Leave blank
- **Output Directory:** Leave blank
- **Root Directory:** Leave blank (Vercel will auto-detect)

### 2.4 Deploy
Click **"Deploy"**

Wait 2-5 minutes for deployment to complete.

### 2.5 Get Your Vercel URL
After deployment succeeds, you'll see:
```
https://meet-assistant-abc123def456.vercel.app
```

Copy this URL (you'll need it next).

---

## Step 3: Configure Extension

After deployment, update the extension to use your Vercel server.

### 3.1 Set Server URL + API Key in Extension

1. Open a Google Meet call
2. Click the Meet Assistant extension icon
3. Click the **settings gear icon** (top-right of popup)
4. Enter:
   - **Server URL:** `https://meet-assistant-abc123def456.vercel.app`
   - **API Key:** _(the same `API_KEY` value you set in Vercel)_
5. Click **"Guardar"**

### 3.2 Reload Extension
1. Go to: `chrome://extensions/`
2. Find "Meet Assistant"
3. Click the **refresh icon** (circular arrow)
4. Extension now uses Vercel server with API key auth

---

## Step 4: Test the Deployment

### 4.1 Test Dashboard
1. Open: `https://your-vercel-url/dashboard`
2. You should see the web interface
3. Click "Load Meetings" (should show any previous recordings)

### 4.2 Test Extension
1. Open a Google Meet call
2. Click the Meet Assistant icon
3. Click "Iniciar grabacion" (Start Recording)
4. Let it record for 10-15 seconds
5. Click "Detener grabacion" (Stop Recording)
6. Watch the progress bar in the popup for real-time status
7. Check the dashboard - new meeting should appear

### 4.3 View Logs
To debug issues, check Vercel logs:
```bash
# Install Vercel CLI (optional)
npm install -g vercel

# View logs
vercel logs
```

---

## Troubleshooting

### "OPENAI_API_KEY environment variable is required"
**Solution:** Make sure you added the API key in Vercel project settings → Environment Variables

### "Unauthorized" / 401 errors
**Solution:**
- Make sure you set the `API_KEY` env var in Vercel
- Enter the same `API_KEY` value in the extension settings (gear icon)
- If you want to disable auth (dev only), remove the `API_KEY` env var from Vercel

### Extension still calling localhost
**Solution:**
- Open the extension popup, click settings (gear icon), update the Server URL
- Reload the extension (chrome://extensions/ → refresh button)
- Check browser console for errors (F12)

### "Invalid x-api-key" error
**Solution:** Verify your OpenAI API key is valid:
```bash
# Test locally first
export OPENAI_API_KEY="your-key"
export API_KEY="your-secret"
npm start  # in server/ directory
curl -H "x-api-key: your-secret" http://localhost:3456/health
```

### Dashboard loads but no meetings appear
**Solution:**
- This is expected on first deployment (no meetings recorded yet)
- Record a new meeting using the extension to test the full flow
- Check Vercel logs for API errors

### "404 Not Found" on dashboard
**Solution:**
- Make sure you're using the correct Vercel URL
- Check that vercel.json routes are correct
- Redeploy if needed

---

## File Changes Made for Deployment

The following changes were made to support Vercel:

### server/server.js
- Line 10: `const PORT = process.env.PORT || 3456` (dynamic port)
- Removed macOS Keychain fallback (lines 13-21)
- Requires `OPENAI_API_KEY` environment variable
- Optional `API_KEY` for request authentication
- 50MB request body size limit
- `path.basename()` for path traversal protection
- Concurrent meeting list reads (batch of 5)
- SSE `/progress` endpoint for real-time status
- `PATCH /meeting/:id` for renaming meetings
- Auto-detect language in Whisper (no hardcoded `es`)
- Multipart form-data support for direct audio upload

### vercel.json
- `maxDuration: 120` for long transcription timeouts

### extension/background.js
- Recording state persisted in `chrome.storage.local`
- Server URL configurable via settings
- API key support for authenticated requests
- Service worker restart recovery (badge restoration)

### extension/popup.html + popup.js
- Settings panel (gear icon) for Server URL + API Key
- SSE progress bar for real-time transcription status
- Dashboard URL uses configured server URL

### extension/offscreen.js
- Sends audio directly to server via FormData (no base64 overhead)
- Reads server config from `chrome.storage.local`

### server/dashboard.html
- API key auth headers on all fetch calls
- Visibility-aware polling (stops when tab is hidden)
- Rename meeting button
- Removed emoji for accessibility

### New Files
- `server/test/storage.test.js` - Unit tests for storage abstraction
- `vercel.json` - Vercel deployment configuration
- `.gitignore` - Git ignore patterns
- `DEPLOYMENT.md` - This file

---

## Local Development (Optional)

To keep developing locally while Vercel runs production:

### Run Local Server
```bash
cd server
export OPENAI_API_KEY=$(security find-generic-password -s OPENAI_API_KEY -w)
npm start
# Server runs on http://localhost:3456
```

### Run Tests
```bash
cd server
npm test
```

### Keep Extension Pointing Locally
In the extension popup settings:
- **Server URL:** `http://localhost:3456`
- **API Key:** _(leave blank for dev mode)_

---

## Support

### Common Issues
- Check Vercel logs: `vercel logs`
- Check browser console: F12 Developer Tools
- Verify API key is set in Vercel dashboard
- Verify API key matches in extension settings

### More Info
- Vercel Docs: https://vercel.com/docs
- OpenAI API: https://platform.openai.com/docs
- Chrome Extensions: https://developer.chrome.com/docs/extensions/

---

## Next Steps After Deployment

1. Dashboard is live at your Vercel URL
2. Extension points to production server with API key auth
3. Test by recording a meeting
4. (Optional) Publish extension to Chrome Web Store
5. (Optional) Add user management / multi-tenant support
6. (Optional) Set up Vercel KV for meeting metadata caching

---

**Questions?** Check the troubleshooting section or review Vercel/OpenAI documentation.
