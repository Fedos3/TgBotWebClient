import {
  Api,
  NewMessage,
  EditedMessage,
  peerToBotApiId,
  detectMedia,
  resolveFromName,
  extractReplyMarkup,
  getEntityPhotoFileId,
} from './mtproto.js';
import {
  getChat,
  upsertChat,
  insertMessage,
  touchChatLastMsg,
  getMessageIdBounds,
  listMessageIdGaps,
  getMeta,
  setMeta,
} from './db.js';

const nowSec = () => Math.floor(Date.now() / 1000);

const entityChatRow = (entity, type) => ({
  id: peerToBotApiId(
    type === 'private'
      ? { className: 'PeerUser', userId: entity.id }
      : type === 'channel' || type === 'supergroup'
      ? { className: 'PeerChannel', channelId: entity.id }
      : { className: 'PeerChat', chatId: entity.id },
  ),
  type,
  title: entity.title || null,
  username: entity.username || null,
  first_name: entity.firstName || null,
  last_name: entity.lastName || null,
  photo_file_id: getEntityPhotoFileId(entity),
  updated_at: nowSec(),
});

async function resolveChat(client, peer, knownEntity) {
  const chatId = peerToBotApiId(peer);
  try {
    // getEntity() always hits users.getUsers; reuse the entity that came with
    // the message when there is one (backfill would otherwise do 1 call/msg).
    const entity = knownEntity?.className ? knownEntity : await client.getEntity(peer);
    let type = 'private';
    if (entity.className === 'Chat') type = 'group';
    else if (entity.className === 'Channel') type = entity.megagroup ? 'supergroup' : 'channel';
    return { chatId, row: entityChatRow(entity, type), entity };
  } catch {
    return {
      chatId,
      row: {
        id: chatId, type: 'private', title: null, username: null,
        first_name: null, last_name: null, photo_file_id: null, updated_at: nowSec(),
      },
      entity: null,
    };
  }
}

function msgPreview(msg, media) {
  if (msg.message) return String(msg.message).slice(0, 200);
  if (media.type) return `[${media.type}]`;
  return '[message]';
}

function createMessageIngestor({ client, me, botId, onEvent }) {
  const currentBotUserId = Number(me.id);

  return async function ingestMessage(msg, { isEdited = false, isBackfill = false } = {}) {
    if (!msg || msg.className !== 'Message') return false;

    const peer = msg.peerId;
    const { chatId, row: chatRow } = await resolveChat(client, peer, msg.chat);
    if (chatId == null) return false;
    upsertChat(botId, chatRow);

    const fromPeer = msg.fromId || peer;
    const fromId = peerToBotApiId(fromPeer);
    let fromName = null;
    try {
      const sender = await msg.getSender();
      fromName = resolveFromName(sender, fromPeer);
      if (sender && chatRow.type === 'private' && fromId !== currentBotUserId) {
        upsertChat(botId, {
          ...entityChatRow(sender, 'private'),
        });
      }
    } catch {}

    const media = detectMedia(msg);
    const isOutgoing = msg.out ? 1 : 0;
    const markup = extractReplyMarkup(msg);

    const row = {
      id: Number(msg.id),
      chat_id: chatId,
      date: Number(msg.date),
      from_id: fromId,
      from_name: fromName,
      is_outgoing: isOutgoing,
      text: msg.message || null,
      media_type: media.type,
      media_file_id: media.fileId,
      media_meta: media.meta ? JSON.stringify(media.meta) : null,
      reply_to_id: msg.replyTo?.replyToMsgId ? Number(msg.replyTo.replyToMsgId) : null,
      reply_markup: markup ? JSON.stringify(markup) : null,
      raw: null,
    };

    insertMessage(botId, row);
    touchChatLastMsg(botId, {
      id: row.id,
      date: row.date,
      text: msgPreview(msg, media),
      is_outgoing: isOutgoing,
      chat_id: chatId,
    }, { countUnread: !isEdited });

    if (!isBackfill) {
      onEvent({
        type: isEdited ? 'messageEdited' : 'message',
        botId: String(botId),
        chatId,
        chat: getChat(botId, chatId) || chatRow,
        message: row,
      });
    }

    return true;
  };
}

const BACKFILL_BATCH = 100;
const BACKFILL_PAUSE_MS = 300;
// Ids are only consumed by real messages, so this many empty ids in a row
// past the newest stored one means we have caught up.
const BACKFILL_EMPTY_STREAK = 300;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchAndIngestIds(client, ingest, ids) {
  const messages = await client.getMessages(undefined, { ids });
  let found = 0;
  for (const msg of messages) {
    try {
      if (await ingest(msg, { isBackfill: true })) found += 1;
    } catch (err) {
      console.error('[backfill] message', msg?.id, err.message);
    }
  }
  return found;
}

// Bots cannot read chat history, but messages.getMessages by id works for any
// message the bot sent or received. Ids are sequential per bot, so missing
// ranges in the local DB are exactly what was lost while the panel was offline.
async function runBackfill({ client, botId, ingest }) {
  const scannedKey = `backfill_scanned_${botId}`;
  const scannedUpTo = Number(getMeta(scannedKey) || 0);
  const { min_id: minId, max_id: maxId } = getMessageIdBounds(botId) || {};

  const ranges = [];
  if (!scannedUpTo && minId > 1) ranges.push({ from: 1, to: minId - 1 });
  if (maxId) ranges.push(...listMessageIdGaps(botId, scannedUpTo));

  let restored = 0;
  const total = ranges.reduce((sum, range) => sum + range.to - range.from + 1, 0);
  if (total) console.log(`[backfill:${botId}] checking ${total} missing ids in ${ranges.length} ranges`);

  for (const range of ranges) {
    for (let from = range.from; from <= range.to; from += BACKFILL_BATCH) {
      const to = Math.min(from + BACKFILL_BATCH - 1, range.to);
      const ids = Array.from({ length: to - from + 1 }, (_, i) => from + i);
      restored += await fetchAndIngestIds(client, ingest, ids);
      await pause(BACKFILL_PAUSE_MS);
    }
  }

  let next = (getMessageIdBounds(botId)?.max_id || 0) + 1;
  let emptyStreak = 0;
  while (emptyStreak < BACKFILL_EMPTY_STREAK) {
    const ids = Array.from({ length: BACKFILL_BATCH }, (_, i) => next + i);
    const found = await fetchAndIngestIds(client, ingest, ids);
    restored += found;
    emptyStreak = found ? 0 : emptyStreak + BACKFILL_BATCH;
    next += BACKFILL_BATCH;
    await pause(BACKFILL_PAUSE_MS);
  }

  setMeta(scannedKey, getMessageIdBounds(botId)?.max_id || 0);
  if (restored) console.log(`[backfill:${botId}] restored ${restored} messages`);
  return restored;
}

const BACKFILL_INTERVAL_MS = 10 * 60 * 1000;

export function attachPoller({ client, me, botId, onEvent }) {
  const ingest = createMessageIngestor({ client, me, botId, onEvent });

  client.addEventHandler((event) => { ingest(event.message).catch((e) => console.error('[poller]', e.message)); }, new NewMessage({}));
  client.addEventHandler((event) => { ingest(event.message, { isEdited: true }).catch((e) => console.error('[poller/edit]', e.message)); }, new EditedMessage({}));

  let running;
  const backfill = () => {
    running ||= runBackfill({ client, botId, ingest })
      .catch((err) => console.error(`[backfill:${botId}]`, err.message))
      .finally(() => { running = undefined; });
    return running;
  };

  // Updates that arrive while the connection is down are not replayed for
  // bots, so re-check for gaps on start and then periodically.
  backfill();
  setInterval(backfill, BACKFILL_INTERVAL_MS).unref();

  return { backfill };
}

export async function sendMessageMtproto(client, chatId, text) {
  const entity = await client.getEntity(chatId);
  const result = await client.sendMessage(entity, { message: text });
  const msg = Array.isArray(result) ? result[0] : result;
  return {
    id: Number(msg.id),
    date: Number(msg.date),
    text: msg.message || text,
    peer: msg.peerId,
  };
}

export async function pressCallbackButton(client, chatId, msgId, dataBase64) {
  const entity = await client.getEntity(chatId);
  const data = Buffer.from(dataBase64, 'base64');
  const res = await client.invoke(new Api.messages.GetBotCallbackAnswer({
    peer: entity,
    msgId: Number(msgId),
    data,
  }));
  return {
    message: res.message || null,
    alert: !!res.alert,
    url: res.url || null,
  };
}
