import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createMtprotoClient, downloadMessageMedia, downloadProfileMedia, getEntityPhotoFileId } from './mtproto.js';
import { attachPoller, sendMessageMtproto, pressCallbackButton } from './mtproto-poller.js';
import { createAuth } from './auth.js';
import { EventHub } from './events.js';
import {
  listChats,
  listMessages,
  markRead,
  upsertChat,
  insertMessage,
  touchChatLastMsg,
  getChat,
  getMessage,
  listMessagesByIds,
  findMessageByMediaFileId,
  migrateLegacyData,
  listStoredBotAccounts,
  saveStoredBotAccount,
  getStoredBotAccountByTokenHash,
} from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  BOT_TOKEN,
  BOT_LABEL,
  API_ID,
  API_HASH,
  PANEL_PASSWORD,
  PANEL_BASIC_AUTH,
  SESSION_SECRET,
  BOT_STORE_SECRET,
  PORT = 3000,
  FRONTEND_DIST,
} = process.env;

const LOGIN_WINDOW_MS = Number(process.env.LOGIN_WINDOW_MS || 15 * 60 * 1000);
const LOGIN_MAX_ATTEMPTS = Number(process.env.LOGIN_MAX_ATTEMPTS || 10);
const MAX_BOTS = 5;
const TOKEN_STORE_KEY = crypto.createHash('sha256').update(String(BOT_STORE_SECRET || SESSION_SECRET || '')).digest();

if (!TOKEN_STORE_KEY.length) {
  throw new Error('SESSION_SECRET or BOT_STORE_SECRET is required');
}

// GramJS runs its update/reconnect loops as detached promises; one failing
// there must not kill the panel.
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err?.stack || err);
});

const loginAttemptsByIp = new Map();
const hub = new EventHub();
const botById = new Map();
const botClients = [];
let defaultBotId;

function getClientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function getLoginAttemptState(req) {
  const ip = getClientIp(req);
  const now = Date.now();
  const current = loginAttemptsByIp.get(ip);

  if (!current || current.resetAt <= now) {
    const fresh = { count: 0, resetAt: now + LOGIN_WINDOW_MS };
    loginAttemptsByIp.set(ip, fresh);
    return { ip, state: fresh };
  }

  return { ip, state: current };
}

function isLoginRateLimited(req) {
  const { state } = getLoginAttemptState(req);
  return state.count >= LOGIN_MAX_ATTEMPTS ? state.resetAt : null;
}

function registerLoginFailure(req) {
  const { state } = getLoginAttemptState(req);
  state.count += 1;
}

function clearLoginFailures(req) {
  loginAttemptsByIp.delete(getClientIp(req));
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function normalizeLabel(label, fallback) {
  const normalized = String(label || '').trim().slice(0, 80);
  return normalized || fallback;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('base64url');
}

function encryptToken(token) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', TOKEN_STORE_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(String(token), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

function decryptToken(payload) {
  if (!payload) {
    throw new Error('missing_encrypted_token');
  }

  const [version, ivRaw, tagRaw, dataRaw] = String(payload).split('.');
  if (version !== 'v1' || !ivRaw || !tagRaw || !dataRaw) {
    throw new Error('invalid_encrypted_token');
  }

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    TOKEN_STORE_KEY,
    Buffer.from(ivRaw, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));

  return Buffer.concat([
    decipher.update(Buffer.from(dataRaw, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

function getUsedSlots() {
  return new Set(botClients.map((bot) => String(bot.slot)));
}

function pickNextSlot(usedSlots = getUsedSlots()) {
  for (let i = 1; i <= MAX_BOTS; i++) {
    const slot = String(i);
    if (!usedSlots.has(slot)) {
      return slot;
    }
  }

  return undefined;
}

function sortRuntimeBots() {
  botClients.sort((left, right) => Number(left.slot) - Number(right.slot));
  defaultBotId = botClients[0]?.id;
}

function serializeBot(bot) {
  return {
    id: bot.id,
    slot: bot.slot,
    label: bot.label,
    username: bot.me.username,
    firstName: bot.me.first_name,
    photo_file_id: bot.me.photo_file_id,
  };
}

function buildBotsPayload() {
  return {
    defaultBotId,
    maxBots: MAX_BOTS,
    canAddMore: botClients.length < MAX_BOTS,
    bots: botClients.map(serializeBot),
  };
}

function buildEnvBotConfigs() {
  const configs = [];

  if (BOT_TOKEN && !process.env.BOT_TOKEN_1) {
    configs.push({
      slot: '1',
      token: BOT_TOKEN,
      label: BOT_LABEL || 'Bot 1',
      source: 'env',
      tokenHash: hashToken(BOT_TOKEN),
    });
  }

  for (let i = 1; i <= MAX_BOTS; i++) {
    const token = process.env[`BOT_TOKEN_${i}`];
    if (!token) continue;

    configs.push({
      slot: String(i),
      token,
      label: process.env[`BOT_LABEL_${i}`] || `Bot ${i}`,
      source: 'env',
      tokenHash: hashToken(token),
    });
  }

  const seen = new Set();
  return configs.filter((config) => {
    if (seen.has(config.tokenHash)) {
      return false;
    }

    seen.add(config.tokenHash);
    return true;
  }).slice(0, MAX_BOTS);
}

function buildStoredBotConfigs(envConfigs) {
  const usedSlots = new Set(envConfigs.map((config) => String(config.slot)));
  const usedHashes = new Set(envConfigs.map((config) => config.tokenHash));
  const configs = [];

  for (const account of listStoredBotAccounts()) {
    if (usedHashes.has(account.token_hash)) {
      continue;
    }

    let token;
    try {
      token = decryptToken(account.token_enc);
    } catch (err) {
      console.error(`[bot:${account.slot}] failed to decrypt stored token: ${err.message}`);
      continue;
    }

    const slot = usedSlots.has(String(account.slot))
      ? pickNextSlot(usedSlots)
      : String(account.slot);

    if (!slot) {
      break;
    }

    usedSlots.add(slot);
    usedHashes.add(account.token_hash);
    configs.push({
      slot,
      token,
      label: account.label || `Bot ${slot}`,
      source: 'dynamic',
      tokenHash: account.token_hash,
      persistedAccount: account,
    });

    if (usedSlots.size >= MAX_BOTS) {
      break;
    }
  }

  return configs;
}

async function connectRuntimeBot(config, options = {}) {
  const {
    shouldPersist = false,
    allowStoredSlotRefresh = false,
  } = options;

  if (botClients.length >= MAX_BOTS) {
    throw new Error('bot_limit_reached');
  }

  const tokenHash = config.tokenHash || hashToken(config.token);
  if (botClients.some((bot) => bot.tokenHash === tokenHash)) {
    throw new Error('bot_already_connected');
  }

  const slot = String(config.slot);
  const { client, me } = await createMtprotoClient({
    apiId: API_ID,
    apiHash: API_HASH,
    botToken: config.token,
    sessionKey: `mtproto_session_${slot}`,
  });

  const botId = String(me.id);
  if (botById.has(botId)) {
    await client.disconnect().catch(() => {});
    throw new Error('bot_already_connected');
  }

  const bot = {
    slot,
    id: botId,
    label: normalizeLabel(config.label, me.firstName || me.username || `Bot ${slot}`),
    tokenHash,
    source: config.source || 'env',
    client,
    me: {
      id: Number(me.id),
      username: me.username,
      first_name: me.firstName,
      photo_file_id: getEntityPhotoFileId(me),
    },
  };

  if (shouldPersist || (allowStoredSlotRefresh && config.source === 'dynamic')) {
    saveStoredBotAccount({
      slot: bot.slot,
      label: bot.label,
      token_enc: encryptToken(config.token),
      token_hash: tokenHash,
      source: 'dynamic',
      bot_id: bot.id,
      username: bot.me.username,
      first_name: bot.me.first_name,
      photo_file_id: bot.me.photo_file_id,
      added_at: config.persistedAccount?.added_at || nowSec(),
    });
  }

  botClients.push(bot);
  botById.set(bot.id, bot);
  sortRuntimeBots();

  attachPoller({
    client: bot.client,
    me: bot.me,
    botId: bot.id,
    onEvent: (event) => hub.broadcast(event),
  });

  console.log(`[bot:${bot.slot}] @${bot.me.username} (id=${bot.id}) connected via MTProto`);
  return bot;
}

const BOT_RETRY_MIN_MS = 15 * 1000;
const BOT_RETRY_MAX_MS = 5 * 60 * 1000;

// A bot that cannot reach Telegram right now (network outage, blocked DC)
// keeps retrying in the background instead of taking the whole panel down.
function connectWithRetry(config, attempt = 0) {
  connectRuntimeBot(config, { allowStoredSlotRefresh: true })
    .then(() => {
      if (defaultBotId && attempt > 0) migrateLegacyData(defaultBotId);
    })
    .catch((err) => {
      if (err.message === 'bot_already_connected' || err.message === 'bot_limit_reached') return;
      const delay = Math.min(BOT_RETRY_MIN_MS * 2 ** attempt, BOT_RETRY_MAX_MS);
      console.error(`[bot:${config.slot}] ${err.message}; retrying in ${Math.round(delay / 1000)}s`);
      setTimeout(() => connectWithRetry(config, attempt + 1), delay).unref();
    });
}

async function bootstrapBots() {
  const envConfigs = buildEnvBotConfigs();
  const storedConfigs = buildStoredBotConfigs(envConfigs);
  const startupConfigs = [...envConfigs, ...storedConfigs].slice(0, MAX_BOTS);

  if (!startupConfigs.length) {
    console.warn('[bot] no startup bots configured; waiting for UI connection');
    defaultBotId = undefined;
    return;
  }

  for (const config of startupConfigs) {
    try {
      await connectRuntimeBot(config, { allowStoredSlotRefresh: true });
    } catch (err) {
      console.error(`[bot:${config.slot}] ${err.message}`);
      if (err.message !== 'bot_already_connected') {
        setTimeout(() => connectWithRetry(config, 1), BOT_RETRY_MIN_MS).unref();
      }
    }
  }

  if (!botClients.length) {
    console.warn('[bot] no bots connected yet; panel is up and will keep retrying');
  }
}

await bootstrapBots();
if (defaultBotId) {
  migrateLegacyData(defaultBotId);
}

const auth = createAuth({ password: PANEL_PASSWORD, secret: SESSION_SECRET });

function resolveBotId(req) {
  return String(req.query.botId || req.body?.botId || req.headers['x-bot-id'] || defaultBotId);
}

function getBotContext(req) {
  const botId = resolveBotId(req);
  return botById.get(botId);
}

function getChatType(entity, fallbackType = 'private') {
  if (entity?.className === 'Chat') {
    return 'group';
  }

  if (entity?.className === 'Channel') {
    return entity.megagroup ? 'supergroup' : 'channel';
  }

  if (entity?.className === 'User') {
    return 'private';
  }

  return fallbackType;
}

function buildChatRowFromEntity(entity, fallbackChat) {
  return {
    id: fallbackChat.id,
    type: getChatType(entity, fallbackChat.type),
    title: entity.title || fallbackChat.title || null,
    username: entity.username || fallbackChat.username || null,
    first_name: entity.firstName || fallbackChat.first_name || null,
    last_name: entity.lastName || fallbackChat.last_name || null,
    photo_file_id: getEntityPhotoFileId(entity),
    updated_at: fallbackChat.updated_at || nowSec(),
  };
}

async function hydrateChatRow(bot, chatOrId) {
  const fallbackChat = typeof chatOrId === 'number' ? getChat(bot.id, chatOrId) : chatOrId;
  if (!fallbackChat) {
    return undefined;
  }

  try {
    const entity = await bot.client.getEntity(fallbackChat.id);
    upsertChat(bot.id, buildChatRowFromEntity(entity, fallbackChat));
    return getChat(bot.id, fallbackChat.id) || fallbackChat;
  } catch {
    return fallbackChat;
  }
}

async function hydrateChats(bot, rows) {
  return Promise.all(rows.map((chat) => (chat.photo_file_id ? Promise.resolve(chat) : hydrateChatRow(bot, chat))));
}

async function buildChatsPayload(bot, limit) {
  const chats = await hydrateChats(bot, listChats(bot.id, limit));
  const lastMessages = chats
    .map((chat) => chat.last_message_id ? getMessage(bot.id, chat.id, chat.last_message_id) : undefined)
    .filter(Boolean);

  return { chats, lastMessages };
}

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
});

// PANEL_BASIC_AUTH=user:password — a second, independent credential in front of
// everything (login page, API, static), so a leaked panel password alone is not enough.
const basicAuthExpected = PANEL_BASIC_AUTH
  ? Buffer.from(`Basic ${Buffer.from(PANEL_BASIC_AUTH).toString('base64')}`)
  : null;
if (basicAuthExpected) {
  app.use((req, res, next) => {
    const got = Buffer.from(String(req.headers.authorization || ''));
    if (got.length === basicAuthExpected.length && crypto.timingSafeEqual(got, basicAuthExpected)) return next();
    res.setHeader('WWW-Authenticate', 'Basic realm="panel", charset="UTF-8"');
    res.status(401).end();
  });
}

app.post('/api/login', (req, res) => {
  const retryAt = isLoginRateLimited(req);
  if (retryAt) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil((retryAt - Date.now()) / 1000))));
    return res.status(429).json({ error: 'too_many_attempts' });
  }

  const session = auth.login(req.body?.password, Boolean(req.body?.remember));
  if (!session) {
    registerLoginFailure(req);
    return res.status(401).json({ error: 'invalid_password' });
  }

  clearLoginFailures(req);
  auth.setCookie(res, session.token, {
    remember: session.remember,
    maxAge: session.maxAge,
  });
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  auth.clearCookie(res);
  res.json({ ok: true });
});

app.get('/api/bots', auth.middleware, (_req, res) => {
  res.json(buildBotsPayload());
});

app.post('/api/bots', auth.middleware, async (req, res) => {
  const token = String(req.body?.token || '').trim();
  const label = String(req.body?.label || '').trim();

  if (!token || !token.includes(':')) {
    return res.status(400).json({ error: 'invalid_bot_token' });
  }

  if (botClients.length >= MAX_BOTS) {
    return res.status(400).json({ error: 'bot_limit_reached' });
  }

  const tokenHash = hashToken(token);
  if (botClients.some((bot) => bot.tokenHash === tokenHash) || getStoredBotAccountByTokenHash(tokenHash)) {
    return res.status(409).json({ error: 'bot_already_connected' });
  }

  const slot = pickNextSlot();
  if (!slot) {
    return res.status(400).json({ error: 'bot_limit_reached' });
  }

  try {
    const bot = await connectRuntimeBot({
      slot,
      token,
      label,
      source: 'dynamic',
      tokenHash,
    }, { shouldPersist: true });

    res.json({
      ok: true,
      bot: serializeBot(bot),
      ...buildBotsPayload(),
    });
  } catch (err) {
    console.error('[bot/add]', err);
    res.status(500).json({ error: err.message || 'bot_connect_failed' });
  }
});

app.get('/api/me', auth.middleware, (req, res) => {
  const bot = getBotContext(req);
  if (!bot) {
    return res.json({
      bot: null,
      ...buildBotsPayload(),
    });
  }

  res.json({
    bot: {
      id: bot.me.id,
      slot: bot.slot,
      label: bot.label,
      username: bot.me.username,
      firstName: bot.me.first_name,
      photo_file_id: bot.me.photo_file_id,
    },
  });
});

app.get('/api/chats', auth.middleware, async (req, res) => {
  const bot = getBotContext(req);
  if (!bot) {
    return res.json({ chats: [], lastMessages: [] });
  }
  res.json(await buildChatsPayload(bot, Number(req.query.limit) || 200));
});

app.get('/api/chats/:id', auth.middleware, async (req, res) => {
  const bot = getBotContext(req);
  if (!bot) return res.status(404).json({ error: 'bot_not_found' });

  const chatId = Number(req.params.id);
  const chat = await hydrateChatRow(bot, chatId);
  if (!chat) return res.status(404).json({ error: 'not_found' });

  const lastMessage = chat.last_message_id ? getMessage(bot.id, chat.id, chat.last_message_id) : null;
  res.json({ chat, lastMessage });
});

app.get('/api/chats/:id/messages', auth.middleware, (req, res) => {
  const bot = getBotContext(req);
  if (!bot) return res.status(404).json({ error: 'bot_not_found' });

  const chatId = Number(req.params.id);
  const beforeId = req.query.beforeId ? Number(req.query.beforeId) : undefined;
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  res.json({ messages: listMessages(bot.id, chatId, { beforeId, limit }) });
});

app.post('/api/chats/:id/messages/by-id', auth.middleware, (req, res) => {
  const bot = getBotContext(req);
  if (!bot) return res.status(404).json({ error: 'bot_not_found' });

  const chatId = Number(req.params.id);
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
  res.json({ messages: listMessagesByIds(bot.id, chatId, ids) });
});

app.post('/api/chats/:id/read', auth.middleware, (req, res) => {
  const bot = getBotContext(req);
  if (!bot) return res.status(404).json({ error: 'bot_not_found' });

  const chatId = Number(req.params.id);
  markRead(bot.id, chatId);
  hub.broadcast({ type: 'chatRead', botId: bot.id, chatId });
  res.json({ ok: true });
});

app.post('/api/chats/:id/send', auth.middleware, async (req, res) => {
  const bot = getBotContext(req);
  if (!bot) return res.status(404).json({ error: 'bot_not_found' });

  const chatId = Number(req.params.id);
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'empty' });

  try {
    const sent = await sendMessageMtproto(bot.client, chatId, text);
    const row = {
      id: sent.id,
      chat_id: chatId,
      date: sent.date,
      from_id: bot.me.id,
      from_name: bot.me.first_name || bot.me.username,
      is_outgoing: 1,
      text: sent.text || null,
      media_type: null,
      media_file_id: null,
      media_meta: null,
      reply_to_id: null,
      reply_markup: null,
      raw: null,
    };

    insertMessage(bot.id, row);
    touchChatLastMsg(bot.id, {
      id: row.id,
      date: row.date,
      text: row.text ? row.text.slice(0, 200) : '[message]',
      is_outgoing: 1,
      chat_id: row.chat_id,
    });

    hub.broadcast({ type: 'message', botId: bot.id, chatId, chat: getChat(bot.id, chatId), message: row });
    res.json({ ok: true, message: row });
  } catch (err) {
    console.error('[send]', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/media', auth.middleware, async (req, res) => {
  const bot = getBotContext(req);
  if (!bot) return res.status(404).json({ error: 'bot_not_found' });

  const mediaUrl = String(req.body?.url || '');
  const match = mediaUrl.match(/^(avatar|profile|photo|document|sticker)([^?]+)(?:\?size=([a-z]))?(?:\?.*)?$/i);
  if (!match) {
    return res.status(400).json({ error: 'unsupported_media_url' });
  }

  const [, kind, rawId, sizeType] = match;

  try {
    let downloaded;

    if (kind === 'avatar' || kind === 'profile') {
      downloaded = await downloadProfileMedia(bot.client, {
        peerId: Number(rawId),
        isBig: kind === 'profile',
      });
    } else {
      const mediaFileId = `${kind === 'photo' ? 'photo' : 'doc'}:${rawId}`;
      const message = findMessageByMediaFileId(bot.id, mediaFileId);

      if (!message) {
        return res.status(404).json({ error: 'media_not_found' });
      }

      downloaded = await downloadMessageMedia(bot.client, {
        chatId: message.chat_id,
        messageId: message.id,
        sizeType,
        start: req.body?.start !== undefined ? Number(req.body.start) : undefined,
        end: req.body?.end !== undefined ? Number(req.body.end) : undefined,
      });
    }

    if (!downloaded?.data) {
      return res.status(404).json({ error: 'media_bytes_not_found' });
    }

    if (downloaded.mimeType) {
      res.setHeader('Content-Type', downloaded.mimeType);
    }
    if (downloaded.fullSize) {
      res.setHeader('X-Full-Size', String(downloaded.fullSize));
    }

    return res.end(Buffer.from(downloaded.data));
  } catch (err) {
    console.error('[media]', err);
    return res.status(500).json({ error: err.message || 'media_download_failed' });
  }
});

app.post('/api/chats/:id/callback', auth.middleware, async (req, res) => {
  const bot = getBotContext(req);
  if (!bot) return res.status(404).json({ error: 'bot_not_found' });

  const chatId = Number(req.params.id);
  const msgId = Number(req.body?.msgId);
  const data = String(req.body?.data || '');
  if (!msgId || !data) return res.status(400).json({ error: 'invalid' });

  try {
    const answer = await pressCallbackButton(bot.client, chatId, msgId, data);
    res.json({ ok: true, answer });
  } catch (err) {
    console.error('[callback]', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stream', auth.middleware, (req, res) => {
  const bot = getBotContext(req);
  if (!bot) return res.status(404).json({ error: 'bot_not_found' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  res.on('close', () => clearInterval(ping));
  hub.addClient(res, { botId: bot.id });
});

const defaultFrontendDist = path.resolve(__dirname, '..', '..', 'frontend', 'dist');
const staticDir = FRONTEND_DIST
  ? path.resolve(__dirname, '..', FRONTEND_DIST)
  : (fs.existsSync(defaultFrontendDist) ? defaultFrontendDist : path.resolve(__dirname, '..', 'public'));
const loginPage = path.resolve(__dirname, '..', 'public', 'login.html');

if (fs.existsSync(staticDir)) {
  app.get(/\.map$/i, (_req, res) => {
    res.status(404).end();
  });

  if (fs.existsSync(loginPage)) {
    app.get('/login', (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(loginPage);
    });

    app.get('/', (req, res, next) => {
      if (auth.isAuthorized(req)) {
        return next();
      }

      res.setHeader('Cache-Control', 'no-store');
      return res.sendFile(loginPage);
    });
  }

  app.use(express.static(staticDir, {
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-store');
      }
    },
  }));

  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(staticDir, 'index.html'));
  });
  console.log(`[static] serving ${staticDir}`);
} else {
  console.warn(`[static] directory not found: ${staticDir}`);
}

app.listen(PORT, () => console.log(`[panel] listening on :${PORT}`));

const shutdown = async () => {
  await Promise.allSettled(botClients.map(async (bot) => bot.client.disconnect()));
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
