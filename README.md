# Atem WhatsApp Bot — Deployment Guide

## Overview
A WhatsApp bot that receives user messages via Twilio, sends them to the Anthropic Claude API with a system prompt, and returns formatted recommendation cards via WhatsApp.

**The code is complete. Your job is deployment and account configuration only.**

## Architecture
```
User (WhatsApp) → Twilio → This Server → Claude API → This Server → Twilio → User (WhatsApp)
```

## What You Need to Do

### Step 1: Set Up Hosting
Deploy this server to **Railway**, **Render**, or **Vercel** (any Node.js hosting with HTTPS).

1. Create a new project on your chosen platform
2. Connect this GitHub repo (or upload the files)
3. Set the environment variables listed below
4. Deploy — the platform will run `npm install` and `npm start` automatically

### Step 2: Configure Environment Variables
Set these in your hosting platform's dashboard (NOT in the .env file for production):

| Variable | Description | Who provides |
|---|---|---|
| `TWILIO_ACCOUNT_SID` | Twilio account SID | Founder provides |
| `TWILIO_AUTH_TOKEN` | Twilio auth token | Founder provides |
| `TWILIO_WHATSAPP_NUMBER` | Twilio WhatsApp number (format: `whatsapp:+14155238886`) | Founder provides |
| `ANTHROPIC_API_KEY` | Anthropic API key | Founder provides |
| `ATEM_SYSTEM_PROMPT` | **Use the placeholder prompt for testing.** Founder will set the production prompt after handoff. | Placeholder for testing; founder sets production version |
| `ALLOWED_NUMBERS` | Comma-separated WhatsApp numbers (format: `whatsapp:+447123456789,whatsapp:+491234567890`) | Founder provides |
| `ADMIN_WEBHOOK` | Optional Slack webhook URL for monitoring | Founder provides if wanted |

### Step 3: Configure Twilio Webhook
1. Go to Twilio Console → Messaging → Settings → WhatsApp Sandbox (for testing) or the production WhatsApp number
2. Set the "When a message comes in" webhook URL to: `https://your-deployed-url.com/webhook`
3. Method: POST
4. Save

### Step 4: Test
1. Send a WhatsApp message to the Twilio number
2. You should receive a formatted response within 10-15 seconds
3. Verify the health check: `GET https://your-deployed-url.com/` should return `{"status": "ok"}`

### Step 5: Client Handoff (Security-First)
Following the client's request for strict security, you should not ask for or receive their production keys. Instead:

1.  **Invite to Dashboard**: 
    *   **Railway**: Project Settings → Members → Invite by Email.
    *   **Vercel**: Team Settings → Members → Invite by Email.
2.  **Instruction for Client**: Once invited, the client will:
    *   Go to the **Variables** or **Environment Variables** tab.
    *   Paste their production `ANTHROPIC_API_KEY`, `TWILIO_AUTH_TOKEN`, and `ATEM_SYSTEM_PROMPT`.
    *   The platform will automatically redeploy with the secure keys.
3.  **Handoff Checklist**:
    - [ ] Project private repository URL provided.
    - [ ] Deployed URL provided (e.g., `atem-bot.up.railway.app`).
    - [ ] Twilio webhook configured to use that URL.
    - [ ] Client invited as a member to the hosting platform.
    - [ ] Client confirmed production keys are injected.

## Local Development (for testing)

```bash
# Clone the repo
git clone <repo-url>
cd atem-whatsapp-bot

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit .env with your test credentials
# Use the Twilio WhatsApp Sandbox for testing (no Meta approval needed)

# Run the server
npm run dev

# Expose to the internet for Twilio (use ngrok)
ngrok http 3000

# Set the ngrok URL as your Twilio webhook: https://xxxx.ngrok.io/webhook
```

## Key Design Decisions

- **System prompt is an environment variable**, never hardcoded. The founder controls this independently.
- **Conversation memory** stores the last 5 message pairs per user, in-memory. Resets when the server restarts. This is intentional for the beta — no persistent storage of conversations.
- **Phone numbers are hashed** in logs. The server never logs the actual phone number in plaintext.
- **Allowed numbers list** restricts who can message the bot. Leave empty to allow anyone (not recommended).
- **Admin webhook** optionally sends truncated message logs to Slack for real-time monitoring.

## File Structure
```
├── server.js          # Main application (all logic in one file)
├── package.json       # Dependencies and scripts
├── .env.example       # Environment variable template
├── .gitignore         # Excludes .env and node_modules
└── README.md          # This file
```

## Troubleshooting
- **Bot doesn't respond:** Check that the Twilio webhook URL is correct and the server is running. Check server logs for errors.
- **"System prompt not loaded" in logs:** The `ATEM_SYSTEM_PROMPT` environment variable is not set.
- **"Not in allowed numbers list":** Add the user's number to `ALLOWED_NUMBERS` in the format `whatsapp:+447123456789`.
- **Twilio signature validation fails:** Ensure `TWILIO_AUTH_TOKEN` is correct.
