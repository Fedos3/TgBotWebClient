import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data.sqlite');

export const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL');

try { db.exec('ALTER TABLE messages ADD COLUMN reply_markup TEXT'); } catch {}
try { db.exec('ALTER TABLE bot_accounts ADD COLUMN source TEXT NOT NULL DEFAULT \'dynamic\''); } catch {}
try { db.exec('ALTER TABLE bot_accounts ADD COLUMN bot_id TEXT'); } catch {}
try { db.exec('ALTER TABLE bot_accounts ADD COLUMN username TEXT'); } catch {}
try { db.exec('ALTER TABLE bot_accounts ADD COLUMN first_name TEXT'); } catch {}
try { db.exec('ALTER TABLE bot_accounts ADD COLUMN photo_file_id TEXT'); } catch {}

db.exec(`
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS chats (
    id            INTEGER PRIMARY KEY,
    type          TEXT NOT NULL,
    title         TEXT,
    username      TEXT,
    first_name    TEXT,
    last_name     TEXT,
    photo_file_id TEXT,
    last_message_id   INTEGER,
    last_message_date INTEGER,
    last_message_text TEXT,
    unread_count  INTEGER DEFAULT 0,
    updated_at    INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_chats_last_date ON chats(last_message_date DESC);

  CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER NOT NULL,
    chat_id     INTEGER NOT NULL,
    date        INTEGER NOT NULL,
    from_id     INTEGER,
    from_name   TEXT,
    is_outgoing INTEGER NOT NULL DEFAULT 0,
    text        TEXT,
    media_type  TEXT,
    media_file_id TEXT,
    media_meta  TEXT,
    reply_to_id INTEGER,
    reply_markup TEXT,
    raw         TEXT,
    PRIMARY KEY (chat_id, id)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_chat_date ON messages(chat_id, date DESC);

  CREATE TABLE IF NOT EXISTS bot_chats (
    bot_id          TEXT NOT NULL,
    chat_id         INTEGER NOT NULL,
    type            TEXT NOT NULL,
    title           TEXT,
    username        TEXT,
    first_name      TEXT,
    last_name       TEXT,
    photo_file_id   TEXT,
    last_message_id INTEGER,
    last_message_date INTEGER,
    last_message_text TEXT,
    unread_count    INTEGER DEFAULT 0,
    updated_at      INTEGER NOT NULL,
    PRIMARY KEY (bot_id, chat_id)
  );

  CREATE INDEX IF NOT EXISTS idx_bot_chats_last_date ON bot_chats(bot_id, last_message_date DESC, updated_at DESC);

  CREATE TABLE IF NOT EXISTS bot_messages (
    bot_id         TEXT NOT NULL,
    id             INTEGER NOT NULL,
    chat_id        INTEGER NOT NULL,
    date           INTEGER NOT NULL,
    from_id        INTEGER,
    from_name      TEXT,
    is_outgoing    INTEGER NOT NULL DEFAULT 0,
    text           TEXT,
    media_type     TEXT,
    media_file_id  TEXT,
    media_meta     TEXT,
    reply_to_id    INTEGER,
    reply_markup   TEXT,
    raw            TEXT,
    PRIMARY KEY (bot_id, chat_id, id)
  );

  CREATE INDEX IF NOT EXISTS idx_bot_messages_chat_date ON bot_messages(bot_id, chat_id, date DESC);
  CREATE INDEX IF NOT EXISTS idx_bot_messages_media_file ON bot_messages(bot_id, media_file_id, date DESC, id DESC);

  CREATE TABLE IF NOT EXISTS bot_accounts (
    slot          TEXT PRIMARY KEY,
    label         TEXT,
    token_enc     TEXT NOT NULL,
    token_hash    TEXT NOT NULL UNIQUE,
    source        TEXT NOT NULL DEFAULT 'dynamic',
    bot_id        TEXT,
    username      TEXT,
    first_name    TEXT,
    photo_file_id TEXT,
    added_at      INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_bot_accounts_source ON bot_accounts(source, slot);
  CREATE INDEX IF NOT EXISTS idx_bot_accounts_bot_id ON bot_accounts(bot_id);
`);

export const getMeta = (key) => {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
};

export const setMeta = (key, value) => {
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
};

function mapBotAccountRow(row) {
  if (!row) return undefined;
  return {
    slot: row.slot,
    label: row.label,
    token_enc: row.token_enc,
    token_hash: row.token_hash,
    source: row.source,
    bot_id: row.bot_id,
    username: row.username,
    first_name: row.first_name,
    photo_file_id: row.photo_file_id,
    added_at: row.added_at,
  };
}

const upsertChatStmt = db.prepare(`
  INSERT INTO bot_chats (
    bot_id, chat_id, type, title, username, first_name, last_name, photo_file_id, updated_at
  ) VALUES (
    @bot_id, @chat_id, @type, @title, @username, @first_name, @last_name, @photo_file_id, @updated_at
  )
  ON CONFLICT(bot_id, chat_id) DO UPDATE SET
    type = excluded.type,
    title = COALESCE(excluded.title, bot_chats.title),
    username = COALESCE(excluded.username, bot_chats.username),
    first_name = COALESCE(excluded.first_name, bot_chats.first_name),
    last_name = COALESCE(excluded.last_name, bot_chats.last_name),
    photo_file_id = COALESCE(excluded.photo_file_id, bot_chats.photo_file_id),
    updated_at = excluded.updated_at
`);

// Message ids are a per-bot counter, so a smaller id means an older message
// (e.g. one restored by backfill) that must not replace the chat preview.
const touchChatLastMsgStmt = db.prepare(`
  UPDATE bot_chats SET
    last_message_id = @id,
    last_message_date = @date,
    last_message_text = @text,
    unread_count = CASE WHEN @is_outgoing = 0 AND @count_unread = 1
      THEN COALESCE(unread_count, 0) + 1 ELSE unread_count END,
    updated_at = @date
  WHERE bot_id = @bot_id AND chat_id = @chat_id AND @id >= COALESCE(last_message_id, 0)
`);

const insertMessageStmt = db.prepare(`
  INSERT OR REPLACE INTO bot_messages (
    bot_id, id, chat_id, date, from_id, from_name, is_outgoing, text,
    media_type, media_file_id, media_meta, reply_to_id, reply_markup, raw
  ) VALUES (
    @bot_id, @id, @chat_id, @date, @from_id, @from_name, @is_outgoing, @text,
    @media_type, @media_file_id, @media_meta, @reply_to_id, @reply_markup, @raw
  )
`);

function mapChatRow(row) {
  if (!row) return undefined;
  return {
    id: row.chat_id,
    type: row.type,
    title: row.title,
    username: row.username,
    first_name: row.first_name,
    last_name: row.last_name,
    photo_file_id: row.photo_file_id,
    last_message_id: row.last_message_id,
    last_message_date: row.last_message_date,
    last_message_text: row.last_message_text,
    unread_count: row.unread_count,
    updated_at: row.updated_at,
    bot_id: row.bot_id,
  };
}

function mapMessageRow(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    chat_id: row.chat_id,
    date: row.date,
    from_id: row.from_id,
    from_name: row.from_name,
    is_outgoing: row.is_outgoing,
    text: row.text,
    media_type: row.media_type,
    media_file_id: row.media_file_id,
    media_meta: row.media_meta,
    reply_to_id: row.reply_to_id,
    reply_markup: row.reply_markup,
    raw: row.raw,
    bot_id: row.bot_id,
  };
}

export function upsertChat(botId, chat) {
  upsertChatStmt.run({
    bot_id: String(botId),
    chat_id: chat.id,
    type: chat.type,
    title: chat.title ?? null,
    username: chat.username ?? null,
    first_name: chat.first_name ?? null,
    last_name: chat.last_name ?? null,
    photo_file_id: chat.photo_file_id ?? null,
    updated_at: chat.updated_at,
  });
}

export function insertMessage(botId, msg) {
  insertMessageStmt.run({
    bot_id: String(botId),
    ...msg,
  });
}

export function touchChatLastMsg(botId, row, { countUnread = true } = {}) {
  touchChatLastMsgStmt.run({
    bot_id: String(botId),
    ...row,
    count_unread: countUnread ? 1 : 0,
  });
}

export function runInTransaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getMessageIdBounds(botId) {
  return db.prepare(`
    SELECT MIN(id) AS min_id, MAX(id) AS max_id FROM bot_messages WHERE bot_id = ?
  `).get(String(botId));
}

// Ranges of message ids missing between stored messages, starting above `afterId`.
export function listMessageIdGaps(botId, afterId = 0) {
  return db.prepare(`
    SELECT id + 1 AS from_id, next_id - 1 AS to_id FROM (
      SELECT id, LEAD(id) OVER (ORDER BY id) AS next_id
      FROM bot_messages WHERE bot_id = ?
    )
    WHERE next_id - id > 1 AND next_id > ?
    ORDER BY id
  `).all(String(botId), afterId).map((gap) => ({
    from: Math.max(gap.from_id, afterId + 1),
    to: gap.to_id,
  }));
}

export function listChats(botId, limit = 200) {
  return db.prepare(`
    SELECT * FROM bot_chats
    WHERE bot_id = ?
    ORDER BY COALESCE(last_message_date, updated_at) DESC
    LIMIT ?
  `).all(String(botId), limit).map(mapChatRow);
}

export function getChat(botId, chatId) {
  return mapChatRow(db.prepare(`
    SELECT * FROM bot_chats
    WHERE bot_id = ? AND chat_id = ?
  `).get(String(botId), chatId));
}

export function listMessages(botId, chatId, { beforeId, limit = 50 } = {}) {
  if (beforeId) {
    return db.prepare(`
      SELECT * FROM bot_messages
      WHERE bot_id = ? AND chat_id = ? AND id < ?
      ORDER BY id DESC
      LIMIT ?
    `).all(String(botId), chatId, beforeId, limit).reverse().map(mapMessageRow);
  }

  return db.prepare(`
    SELECT * FROM bot_messages
    WHERE bot_id = ? AND chat_id = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(String(botId), chatId, limit).reverse().map(mapMessageRow);
}

export function getMessage(botId, chatId, messageId) {
  return mapMessageRow(db.prepare(`
    SELECT * FROM bot_messages
    WHERE bot_id = ? AND chat_id = ? AND id = ?
  `).get(String(botId), chatId, messageId));
}

export function listMessagesByIds(botId, chatId, ids = []) {
  if (!ids.length) return [];

  const placeholders = ids.map(() => '?').join(', ');
  return db.prepare(`
    SELECT * FROM bot_messages
    WHERE bot_id = ? AND chat_id = ? AND id IN (${placeholders})
    ORDER BY id ASC
  `).all(String(botId), chatId, ...ids).map(mapMessageRow);
}

export function findMessageByMediaFileId(botId, mediaFileId) {
  return mapMessageRow(db.prepare(`
    SELECT * FROM bot_messages
    WHERE bot_id = ? AND media_file_id = ?
    ORDER BY date DESC, id DESC
    LIMIT 1
  `).get(String(botId), mediaFileId));
}

export function markRead(botId, chatId) {
  db.prepare('UPDATE bot_chats SET unread_count = 0 WHERE bot_id = ? AND chat_id = ?')
    .run(String(botId), chatId);
}

export function listStoredBotAccounts() {
  return db.prepare(`
    SELECT * FROM bot_accounts
    ORDER BY CAST(slot AS INTEGER) ASC, added_at ASC
  `).all().map(mapBotAccountRow);
}

export function getStoredBotAccountByTokenHash(tokenHash) {
  return mapBotAccountRow(db.prepare(`
    SELECT * FROM bot_accounts
    WHERE token_hash = ?
  `).get(String(tokenHash)));
}

export function saveStoredBotAccount(account) {
  db.prepare(`
    INSERT INTO bot_accounts (
      slot, label, token_enc, token_hash, source, bot_id, username, first_name, photo_file_id, added_at
    ) VALUES (
      @slot, @label, @token_enc, @token_hash, @source, @bot_id, @username, @first_name, @photo_file_id, @added_at
    )
    ON CONFLICT(slot) DO UPDATE SET
      label = excluded.label,
      token_enc = excluded.token_enc,
      token_hash = excluded.token_hash,
      source = excluded.source,
      bot_id = excluded.bot_id,
      username = excluded.username,
      first_name = excluded.first_name,
      photo_file_id = excluded.photo_file_id,
      added_at = excluded.added_at
  `).run({
    slot: String(account.slot),
    label: account.label ?? null,
    token_enc: account.token_enc,
    token_hash: account.token_hash,
    source: account.source || 'dynamic',
    bot_id: account.bot_id ?? null,
    username: account.username ?? null,
    first_name: account.first_name ?? null,
    photo_file_id: account.photo_file_id ?? null,
    added_at: Number(account.added_at),
  });
}

export function migrateLegacyData(defaultBotId) {
  const marker = `legacy_migrated_${defaultBotId}`;
  if (getMeta(marker)) {
    return;
  }

  const hasLegacyChats = db.prepare('SELECT 1 FROM chats LIMIT 1').get();
  if (!hasLegacyChats) {
    setMeta(marker, '1');
    return;
  }

  const hasScopedChats = db.prepare('SELECT 1 FROM bot_chats WHERE bot_id = ? LIMIT 1').get(String(defaultBotId));
  if (hasScopedChats) {
    setMeta(marker, '1');
    return;
  }

  db.exec('BEGIN');
  try {
    db.prepare(`
      INSERT OR IGNORE INTO bot_chats (
        bot_id, chat_id, type, title, username, first_name, last_name, photo_file_id,
        last_message_id, last_message_date, last_message_text, unread_count, updated_at
      )
      SELECT ?, id, type, title, username, first_name, last_name, photo_file_id,
             last_message_id, last_message_date, last_message_text, unread_count, updated_at
      FROM chats
    `).run(String(defaultBotId));

    db.prepare(`
      INSERT OR IGNORE INTO bot_messages (
        bot_id, id, chat_id, date, from_id, from_name, is_outgoing, text,
        media_type, media_file_id, media_meta, reply_to_id, reply_markup, raw
      )
      SELECT ?, id, chat_id, date, from_id, from_name, is_outgoing, text,
             media_type, media_file_id, media_meta, reply_to_id, reply_markup, raw
      FROM messages
    `).run(String(defaultBotId));

    setMeta(marker, '1');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
