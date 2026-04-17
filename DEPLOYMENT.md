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
2. Make sure it's set for all environments (Production, Preview, Development)

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

## Step 3: Update Extension with Vercel URL

After deployment, update the extension to use your Vercel server.

### 3.1 Edit Extension Configuration

1. Open: `/Users/juaneszepeda/meet asistanrt/extension/background.js`
2. Find line 5: `const SERVER_URL = "http://localhost:3456";`
3. Replace with your Vercel URL:
   ```javascript
   const SERVER_URL = "https://meet-assistant-abc123def456.vercel.app";
   ```
4. Save the file

### 3.2 Reload Extension
1. Go to: `chrome://extensions/`
2. Find "Meet Assistant"
3. Click the **refresh icon** (circular arrow)
4. Extension now uses Vercel server ✓

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
6. Wait 30-60 seconds for Whisper + GPT processing
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

### Extension still calling localhost
**Solution:** 
- Check that you updated `SERVER_URL` in extension/background.js
- Reload the extension (chrome://extensions/ → refresh button)
- Check browser console for errors (F12)

### "Invalid x-api-key" error
**Solution:** Verify your OpenAI API key is valid:
```bash
# Test locally first
export OPENAI_API_KEY="your-key"
npm start  # in server/ directory
curl http://localhost:3456/health
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

### extension/background.js
- Line 5: Can be updated to your Vercel URL
- Fallback to localhost for local development

### New Files
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

### Keep Extension Pointing Locally
In `extension/background.js`, keep:
```javascript
const SERVER_URL = "http://localhost:3456";
```

---

## Support

### Common Issues
- Check Vercel logs: `vercel logs`
- Check browser console: F12 Developer Tools
- Verify API key is set in Vercel dashboard

### More Info
- Vercel Docs: https://vercel.com/docs
- OpenAI API: https://platform.openai.com/docs
- Chrome Extensions: https://developer.chrome.com/docs/extensions/

---

## Next Steps After Deployment

1. ✅ Dashboard is live at your Vercel URL
2. ✅ Extension points to production server
3. Test by recording a meeting
4. (Optional) Publish extension to Chrome Web Store
5. (Optional) Set up persistent file storage (Vercel Blob)
6. (Optional) Add authentication/user management

---

**Questions?** Check the troubleshooting section or review Vercel/OpenAI documentation.
