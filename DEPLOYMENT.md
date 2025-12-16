# Deployment Guide for Infinity Runner

This guide will help you deploy the Infinity Runner application to Render.com's free tier.

## Prerequisites

1. A GitHub account
2. A Render.com account (free tier)
3. A GitHub Personal Access Token with `repo` permissions

## Step 1: Create a GitHub Repository for Data Storage

1. Go to GitHub and create a new repository (e.g., `infinity-runner-data`)
2. This repository will store the computation progress
3. Keep it public or private (both work)

## Step 2: Generate a GitHub Personal Access Token

1. Go to GitHub Settings → Developer settings → Personal access tokens → Tokens (classic)
2. Click "Generate new token (classic)"
3. Give it a name: "Infinity Runner"
4. Select the `repo` scope (all sub-permissions)
5. Generate token and copy it (you won't see it again!)

## Step 3: Deploy to Render.com

1. Go to [Render.com](https://render.com) and sign in
2. Click "New +" and select "Web Service"
3. Connect your GitHub account if not already connected
4. Select the `Infinity-runner` repository
5. Configure the service:
   - **Name**: `infinity-runner` (or your choice)
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: `Free`

## Step 4: Configure Environment Variables

In the Render dashboard, add these environment variables:

| Variable | Value | Example |
|----------|-------|---------|
| `GITHUB_TOKEN` | Your Personal Access Token | `ghp_xxxxxxxxxxxx` |
| `GITHUB_OWNER` | Your GitHub username | `your-username` |
| `GITHUB_REPO` | Your data repository name | `infinity-runner-data` |
| `PORT` | Leave blank (Render sets this) | - |

## Step 5: Deploy

1. Click "Create Web Service"
2. Render will automatically deploy your application
3. Wait for the build to complete (2-3 minutes)
4. Your app will be live at `https://infinity-runner.onrender.com` (or your chosen name)

## Step 6: Verify

1. Open your Render URL in a browser
2. You should see the Infinity Runner interface
3. Check that it shows "Connected" status
4. Watch numbers being computed in real-time
5. After 10 minutes, check your data repository for the saved progress

## Important Notes

### Free Tier Limitations

- The free tier sleeps after 15 minutes of inactivity
- First request after sleep takes ~30 seconds to wake up
- 750 hours/month of runtime (plenty for 24/7 operation)
- Perfect for this application!

### Save Interval

The application saves every 10 minutes specifically to:
- Avoid GitHub API rate limiting (60 requests/hour for unauthenticated, 5000/hour for authenticated)
- Work efficiently on free tier resources
- Ensure data persistence without overwhelming GitHub

### Monitoring

Check the Render logs to see:
- Computation progress
- Save events
- Any errors or issues

## Troubleshooting

### App Won't Start
- Check environment variables are set correctly
- Verify GitHub token has `repo` permissions
- Check Render logs for specific errors

### GitHub Save Errors
- Verify token is valid and not expired
- Check repository exists and is accessible
- Ensure token has correct permissions

### WebSocket Connection Issues
- The app automatically handles HTTP/HTTPS
- Check browser console for connection errors
- Ensure Render service is running (not sleeping)

## Updating the Application

To update after making changes:
1. Push changes to your GitHub repository
2. Render will automatically detect and redeploy
3. Or manually trigger a deploy in Render dashboard

## Costs

**This deployment is 100% FREE** using:
- Render.com free tier
- GitHub free tier
- No credit card required!

Enjoy your infinite Fibonacci computation! 🚀
