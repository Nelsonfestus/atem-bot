import express from 'express';
import twilio from 'twilio';
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
import crypto from 'crypto';

dotenv.config();

// ============================================================
// CONFIGURATION — All sensitive values loaded from environment
// ============================================================
const PORT = process.env.PORT || 3000;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER; // e.g., "whatsapp:+14155238886"
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ATEM_SYSTEM_PROMPT = process.env.ATEM_SYSTEM_PROMPT;
const ALLOWED_NUMBERS = process.env.ALLOWED_NUMBERS
  ? process.env.ALLOWED_NUMBERS.split(',').map(n => n.trim())
  : []; // Empty = allow all. Comma-separated list of whatsapp:+numbers to restrict access.
const ADMIN_WEBHOOK = process.env.ADMIN_WEBHOOK || null; // Optional Slack webhook for monitoring

// ============================================================
// CLIENTS
// ============================================================
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ============================================================
// CONVERSATION MEMORY — In-memory store, per user
// Stores last 5 message pairs per user phone number (hashed)
// ============================================================
const conversations = new Map();
const MAX_HISTORY = 5;

function hashPhone(phone) {
  return crypto.createHash('sha256').update(phone).digest('hex').substring(0, 16);
}

function getHistory(userPhone) {
  const key = hashPhone(userPhone);
  if (!conversations.has(key)) {
    conversations.set(key, []);
  }
  return conversations.get(key);
}

function addToHistory(userPhone, role, content) {
  const history = getHistory(userPhone);
  history.push({ role, content });
  // Keep only the last MAX_HISTORY pairs (10 messages = 5 user + 5 assistant)
  while (history.length > MAX_HISTORY * 2) {
    history.shift();
  }
}

// ============================================================
// FORMAT CARD FOR WHATSAPP
// Converts the JSON card into a readable WhatsApp message
// ============================================================
function formatCardForWhatsApp(cardJson) {
  try {
    const card = typeof cardJson === 'string' ? JSON.parse(cardJson) : cardJson;
    const c = card.collapsed || {};
    const e = card.expanded || {};

    let msg = '';

    // Collapsed view
    if (c.situation) msg += `${c.situation}\n\n`;
    if (c.nutrients) msg += `${c.nutrients}\n\n`;
    if (c.timing) msg += `🕐 ${c.timing}\n\n`;
    if (c.items) msg += `🍽️ ${c.items}\n\n`;
    if (c.action) msg += `➡️ *${c.action}*\n`;

    // Divider
    msg += `\n───────────────\n`;
    msg += `_Tap to expand_ ⬇️\n\n`;

    // Expanded view
    if (e.why_this_works) {
      msg += `*Why This Works*\n${e.why_this_works}\n\n`;
    }

    if (e.confidence) {
      msg += `*Confidence:* ${e.confidence}\n\n`;
    }

    if (e.missing_context) {
      msg += `*Would refine this:*\n_${e.missing_context}_\n\n`;
    }

    if (e.supporting_steps && e.supporting_steps.length > 0) {
      msg += `*Supporting steps*\n`;
      e.supporting_steps.forEach((step, i) => {
        msg += `${i + 1}. ${step}\n`;
      });
    }

    msg += `\n_ATEM · Not medical advice_`;

    return msg;
  } catch {
    return null;
  }
}

// ============================================================
// CALL CLAUDE API
// ============================================================
async function getAtemResponse(userPhone, userMessage) {
  const history = getHistory(userPhone);

  // Build messages array with conversation history
  const messages = [
    ...history,
    { role: 'user', content: userMessage }
  ];

  try {
    const response = await anthropic.messages.create({
      model: 'claude-3-5-sonnet-latest',
      max_tokens: 1000,
      system: ATEM_SYSTEM_PROMPT,
      messages: messages
    });

    const assistantText = response.content?.[0]?.text || '';

    // Store in history
    addToHistory(userPhone, 'user', userMessage);
    addToHistory(userPhone, 'assistant', assistantText);

    // Try to parse as JSON card and format
    const cleaned = assistantText
      .replace(/```json\s*/g, '')
      .replace(/```\s*/g, '')
      .trim();

    const formatted = formatCardForWhatsApp(cleaned);

    if (formatted) {
      return formatted;
    }

    // If not valid JSON card, return the raw text (for conversational follow-ups)
    return assistantText;

  } catch (error) {
    console.error('Claude API error:', error.message);
    return 'Atem is temporarily unavailable. Please try again in a moment.';
  }
}

// ============================================================
// ADMIN NOTIFICATION (optional — sends to Slack)
// ============================================================
async function notifyAdmin(userHash, direction, message) {
  if (!ADMIN_WEBHOOK) return;
  try {
    const truncated = message.length > 200 ? message.substring(0, 200) + '...' : message;
    await fetch(ADMIN_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `[${direction}] User ${userHash}: ${truncated}`
      })
    });
  } catch {
    // Silent fail — monitoring should not break the bot
  }
}

// ============================================================
// EXPRESS SERVER
// ============================================================
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'atem-whatsapp-bot', timestamp: new Date().toISOString() });
});

// Twilio WhatsApp webhook — receives incoming messages
// IMPORTANT: Responds to Twilio immediately with 200 OK, then processes
// the AI response asynchronously and sends via REST API. This prevents
// Twilio's 15-second webhook timeout from killing the request when the
// AI API takes longer to respond.
app.post('/webhook', async (req, res) => {
  const from = req.body.From; // e.g., "whatsapp:+447123456789"
  const body = req.body.Body;
  const userHash = hashPhone(from);

  console.log(`[IN] ${userHash}: ${body?.substring(0, 100)}`);

  // Access control — if ALLOWED_NUMBERS is set, only those numbers can use the bot
  if (ALLOWED_NUMBERS.length > 0 && !ALLOWED_NUMBERS.includes(from)) {
    console.log(`[BLOCKED] ${userHash}: not in allowed numbers list`);
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message('This service is currently in private beta. Contact the founder for access.');
    res.type('text/xml').send(twiml.toString());
    return;
  }

  // Immediately acknowledge Twilio with empty TwiML (prevents 15s timeout)
  const twiml = new twilio.twiml.MessagingResponse();
  res.type('text/xml').send(twiml.toString());

  // Process asynchronously — Twilio connection is already closed
  try {
    // Notify admin of incoming message
    await notifyAdmin(userHash, 'IN', body);

    // Get Atem response (may take 10-30 seconds)
    const response = await getAtemResponse(from, body);

    console.log(`[OUT] ${userHash}: ${response?.substring(0, 100)}`);

    // Send reply via Twilio REST API (not TwiML — the webhook response is already sent)
    await twilioClient.messages.create({
      from: TWILIO_WHATSAPP_NUMBER,
      to: from,
      body: response
    });

    // Notify admin of outgoing response
    await notifyAdmin(userHash, 'OUT', response);

  } catch (error) {
    console.error(`[ERROR] ${userHash}: ${error.message}`);
    // Try to send error message to user
    try {
      await twilioClient.messages.create({
        from: TWILIO_WHATSAPP_NUMBER,
        to: from,
        body: 'Atem is temporarily unavailable. Please try again in a moment.'
      });
    } catch {
      console.error(`[ERROR] Failed to send error message to ${userHash}`);
    }
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Atem WhatsApp bot running on port ${PORT}`);
  console.log(`System prompt loaded: ${ATEM_SYSTEM_PROMPT ? 'Yes' : 'NO — set ATEM_SYSTEM_PROMPT env var'}`);
  console.log(`Allowed numbers: ${ALLOWED_NUMBERS.length > 0 ? ALLOWED_NUMBERS.length + ' numbers' : 'All (no restriction)'}`);
  console.log(`Admin webhook: ${ADMIN_WEBHOOK ? 'Configured' : 'Not set'}`);
});
