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
import { getChat, upsertChat, insertMessage, touchChatLastMsg } from './db.js';

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

async function resolveChat(client, peer) {
  const chatId = peerToBotApiId(peer);
  try {
    const entity = await client.getEntity(peer);
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

export function attachPoller({ client, me, botId, onEvent }) {
  const currentBotUserId = Number(me.id);

  const handleMessage = async (event, isEdited = false) => {
    const msg = event.message;
    if (!msg) return;

    const peer = msg.peerId;
    const { chatId, row: chatRow } = await resolveChat(client, peer);
    if (chatId == null) return;
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
    });
    onEvent({
      type: isEdited ? 'messageEdited' : 'message',
      botId: String(botId),
      chatId,
      chat: getChat(botId, chatId) || chatRow,
      message: row,
    });
  };

  client.addEventHandler((event) => { handleMessage(event).catch((e) => console.error('[poller]', e.message)); }, new NewMessage({}));
  client.addEventHandler((event) => { handleMessage(event, true).catch((e) => console.error('[poller/edit]', e.message)); }, new EditedMessage({}));
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
