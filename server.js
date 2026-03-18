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
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ? process.env.ANTHROPIC_API_KEY.trim() : null;
const ATEM_SYSTEM_PROMPT = process.env.ATEM_SYSTEM_PROMPT;
const ALLOWED_NUMBERS = process.env.ALLOWED_NUMBERS
  ? process.env.ALLOWED_NUMBERS.split(',').map(n => n.trim())
  : []; // Empty = allow all. Comma-separated list of whatsapp:+numbers to restrict access.
const ADMIN_WEBHOOK = process.env.ADMIN_WEBHOOK || null; // Optional Slack webhook for monitoring

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

console.log(`[CONFIG] Port: ${PORT}`);

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
// CLEAN MARKDOWN
// Strips asterisks and hashes so WhatsApp plain text looks perfect
// ============================================================
function cleanMarkdown(text) {
  if (!text) return '';
  return text
    .replace(/\*\*(.*?)\*\*/g, '$1') // Removes **bold** markdown
    .replace(/(?<!\w)\*(.*?)\*(?!\w)/g, '$1') // Removes *italic* markdown asterisks
    .replace(/^#+\s+/gm, '') // Removes header ### hashes
    .trim();
}

// ============================================================
// FORMAT CARD FOR WHATSAPP
// Converts the JSON card into a readable WhatsApp message
// ============================================================
function formatCardForWhatsApp(cardJson) {
  try {
    const card = typeof cardJson === 'string' ? JSON.parse(cardJson) : cardJson;
    
    // Strict verification: Must contain at minimum the 'collapsed' object
    if (!card || !card.collapsed || typeof card.collapsed !== 'object') {
      return null; // Signals this is not a valid card, fall back to raw text
    }

    const c = card.collapsed || {};
    const e = card.expanded || {};

    let msg = '';

    // If there ARE exact keys, format them nicely
    if (c.situation || c.nutrients || c.timing || c.items || c.action) {
      if (c.situation) msg += `${cleanMarkdown(c.situation)}\n\n`;
      if (c.nutrients) msg += `${cleanMarkdown(c.nutrients)}\n\n`;
      if (c.timing) msg += `🕐 ${cleanMarkdown(c.timing)}\n\n`;
      if (c.items) msg += `🍽️ ${cleanMarkdown(c.items)}\n\n`;
      if (c.action) msg += `➡️ *${cleanMarkdown(c.action)}*\n`;
    } else {
      // Dynamic Fallback: print whatever keys Claude invented!
      for (const [key, value] of Object.entries(c)) {
        if (value && typeof value === 'string') {
          msg += `*${key.charAt(0).toUpperCase() + key.slice(1)}*:\n${cleanMarkdown(value)}\n\n`;
        }
      }
    }

    // Divider (keeping it clean without the non-functional expand button)
    msg += `\n───────────────\n\n`;

    // Expanded view
    if (e.why_this_works) {
      msg += `*Why This Works*\n${cleanMarkdown(e.why_this_works)}\n\n`;
    } else if (Object.keys(e).length > 0) {
      // Dynamic fallback for expanded section
      for (const [key, value] of Object.entries(e)) {
        if (value && typeof value === 'string' && key !== 'supporting_steps' && key !== 'confidence') {
          msg += `*${key.charAt(0).toUpperCase() + key.slice(1)}*:\n${cleanMarkdown(value)}\n\n`;
        }
      }
    }

    if (e.confidence) {
      msg += `*Confidence:* ${cleanMarkdown(e.confidence)}\n\n`;
    }

    if (e.missing_context) {
      msg += `*Would refine this:*\n_${cleanMarkdown(e.missing_context)}_\n\n`;
    }

    if (e.supporting_steps && e.supporting_steps.length > 0) {
      msg += `*Supporting steps*\n`;
      e.supporting_steps.forEach((step, i) => {
        msg += `${i + 1}. ${cleanMarkdown(step)}\n`;
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
      model: 'claude-sonnet-4-6',
      max_tokens: 2500,
      system: ATEM_SYSTEM_PROMPT,
      messages: messages
    });

    const assistantText = response.content?.[0]?.text || '';
    console.log(`[DEBUG] Claude responded successfully`);

    // Store in history
    addToHistory(userPhone, 'user', userMessage);
    addToHistory(userPhone, 'assistant', assistantText);

    // Clean up template tags, raw markdown, or stopping sequences that might leak
    let cleaned = assistantText
      .replace(/```json\s*/ig, '')
      .replace(/```\s*/g, '')
      .replace(/[\|\}]+$/g, '') // remove trailing }} or || tags at the very end
      .trim();

    // Try to safely extract just the JSON object if there is text before/after it
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      cleaned = jsonMatch[0];
    }
    
    // Attempt format
    let formatted = null;
    try {
      const parsedJSON = JSON.parse(cleaned);
      console.log(`[DEBUG] Parsed JSON keys:`, Object.keys(parsedJSON));
      formatted = formatCardForWhatsApp(parsedJSON);
    } catch(e) {
      console.log(`[DEBUG] Could not JSON parse Claude response:`, e.message);
      formatted = null;
    }

    if (formatted) {
      return formatted;
    }

    // If not valid JSON card, return a clean version of the raw text
    return cleanMarkdown(
      assistantText
        .replace(/```json/ig, '')
        .replace(/```/g, '')
        .replace(/[\|\}]+$/g, '') 
        .replace(/^[\s\{]+|[\s\}]+$/g, '')
    );

  } catch (error) {
    console.error('--- CLAUDE API ERROR ---');
    console.error('Status:', error.status);
    console.error('Type:', error.type);
    console.error('Message:', error.message);
    console.error('Full Error:', JSON.stringify(error, null, 2));
    console.error('------------------------');
    return 'Atem is temporarily unavailable. Please try again in a moment.';
  }
}

// ============================================================
// ADMIN NOTIFICATION (optional — sends to Slack)
// ============================================================
async function notifyAdmin(userHash, direction) {
  if (!ADMIN_WEBHOOK) return;
  try {
    await fetch(ADMIN_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `[${direction}] User ${userHash}`
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
// Railway proxies requests so trust proxy is needed for accurate Twilio validation
app.set('trust proxy', true);
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'atem-whatsapp-bot', timestamp: new Date().toISOString() });
});

// Twilio WhatsApp webhook — receives incoming messages
// Protected by twilio.webhook() signature validation
app.post('/webhook', twilio.webhook({ protocol: 'https' }), async (req, res) => {
  const from = req.body.From; // e.g., "whatsapp:+447123456789"
  const body = req.body.Body;
  const userHash = hashPhone(from);

  console.log(`[IN] Interaction recorded for ${userHash}`);

  // Access control — if ALLOWED_NUMBERS is set, only those numbers can use the bot
  if (ALLOWED_NUMBERS.length > 0 && !ALLOWED_NUMBERS.includes(from)) {
    console.log(`[BLOCKED] ${userHash}: not in allowed numbers list`);
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message('This service is currently in private beta. Contact the founder for access.');
    res.type('text/xml').send(twiml.toString());
    return;
  }

  // Acknowledge Twilio immediately
  const twiml = new twilio.twiml.MessagingResponse();
  res.type('text/xml').send(twiml.toString());

  // Process asynchronously
  try {
    // Notify admin
    await notifyAdmin(userHash, 'IN');

    // Get Atem response (takes time)
    const response = await getAtemResponse(from, body);

    console.log(`[OUT] Processed response for ${userHash}`);

    // Twilio REST API strictly enforces a 1600-character limit per API request (throws Error 21617)
    // for standard free-tier/sandbox wrappers.
    const safeResponse = response.length >= 1600 ? response.substring(0, 1590) + '...' : response;

    await twilioClient.messages.create({
      from: TWILIO_WHATSAPP_NUMBER,
      to: from,
      body: safeResponse
    });

    // Notify admin of outgoing response
    await notifyAdmin(userHash, 'OUT');

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
