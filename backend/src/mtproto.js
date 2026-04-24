import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { EditedMessage } from 'telegram/events/EditedMessage.js';
import { getMeta, setMeta } from './db.js';

export async function createMtprotoClient({ apiId, apiHash, botToken, sessionKey = 'mtproto_session' }) {
  if (!apiId || !apiHash) throw new Error('API_ID and API_HASH are required');
  if (!botToken) throw new Error('BOT_TOKEN is required');

  const saved = getMeta(sessionKey) || '';
  const session = new StringSession(saved);

  const client = new TelegramClient(session, Number(apiId), String(apiHash), {
    connectionRetries: 5,
    useWSS: false,
    autoReconnect: true,
    baseLogger: { log: () => {}, warn: () => {}, error: console.error, info: () => {}, debug: () => {} },
  });

  await client.start({
    botAuthToken: botToken,
    onError: (err) => console.error('[mtproto]', err),
  });

  const newSession = client.session.save();
  if (newSession && newSession !== saved) setMeta(sessionKey, newSession);

  const me = await client.getMe();
  return { client, me };
}

export function getEntityPhotoFileId(entity) {
  const photo = entity?.photo;
  if (!photo || typeof photo !== 'object' || !('photoId' in photo) || !photo.photoId) {
    return null;
  }

  return `photo:${photo.photoId}`;
}

export function peerToBotApiId(peer) {
  if (!peer) return null;
  if (peer.className === 'PeerUser') return Number(peer.userId);
  if (peer.className === 'PeerChat') return -Number(peer.chatId);
  if (peer.className === 'PeerChannel') return Number(`-100${peer.channelId}`);
  return null;
}

export function detectMedia(msg) {
  const media = msg.media;
  if (!media) return { type: null, fileId: null, meta: null };

  if (media.className === 'MessageMediaPhoto' && media.photo) {
    const sizes = media.photo.sizes || [];
    const photoSize = sizes.reduce((best, current) => {
      const currentArea = Number(current?.w || 0) * Number(current?.h || 0);
      const bestArea = Number(best?.w || 0) * Number(best?.h || 0);
      return currentArea > bestArea ? current : best;
    }, null);

    return {
      type: 'photo',
      fileId: `photo:${media.photo.id}`,
      meta: {
        w: Number(photoSize?.w || 0) || undefined,
        h: Number(photoSize?.h || 0) || undefined,
      },
    };
  }
  if (media.className === 'MessageMediaDocument' && media.document) {
    const doc = media.document;
    const attrs = doc.attributes || [];
    const animated = attrs.some((a) => a.className === 'DocumentAttributeAnimated');
    const sticker = attrs.find((a) => a.className === 'DocumentAttributeSticker');
    const video = attrs.find((a) => a.className === 'DocumentAttributeVideo');
    const audio = attrs.find((a) => a.className === 'DocumentAttributeAudio');
    const file = attrs.find((a) => a.className === 'DocumentAttributeFilename');
    let type = 'document';
    if (sticker) type = 'sticker';
    else if (animated) type = 'animation';
    else if (video && video.roundMessage) type = 'video_note';
    else if (video) type = 'video';
    else if (audio && audio.voice) type = 'voice';
    else if (audio) type = 'audio';
    const meta = {
      mime: doc.mimeType,
      size: Number(doc.size) || undefined,
      name: file?.fileName,
      duration: audio?.duration || video?.duration,
      w: video?.w,
      h: video?.h,
      emoji: sticker?.alt,
    };
    return { type, fileId: `doc:${doc.id}`, meta };
  }
  if (media.className === 'MessageMediaGeo' && media.geo) {
    return { type: 'location', fileId: null, meta: { lat: media.geo.lat, lon: media.geo.long } };
  }
  if (media.className === 'MessageMediaContact') {
    return { type: 'contact', fileId: null, meta: {
      phone: media.phoneNumber, firstName: media.firstName, lastName: media.lastName,
    } };
  }
  return { type: 'unknown', fileId: null, meta: { className: media.className } };
}

function getMimeType(data, fallbackMimeType = 'image/jpeg') {
  if (!data || data.length < 4) {
    return fallbackMimeType;
  }

  const signature = data.subarray(0, 4).reduce((result, byte) => result + byte.toString(16), '');

  switch (signature) {
    case '89504e47':
      return 'image/png';
    case '47494638':
      return 'image/gif';
    case 'ffd8ffe0':
    case 'ffd8ffe1':
    case 'ffd8ffe2':
    case 'ffd8ffe3':
    case 'ffd8ffe8':
      return 'image/jpeg';
    case '52494646':
      return 'image/webp';
    default:
      return fallbackMimeType;
  }
}

export async function downloadMessageMedia(client, { chatId, messageId, sizeType, start, end }) {
  const entity = await client.getEntity(chatId);
  const result = await client.getMessages(entity, { ids: [Number(messageId)] });
  const message = Array.isArray(result) ? result[0] : result;
  const media = message?.media;

  if (!media) {
    return undefined;
  }

  if (media.className === 'MessageMediaPhoto' && media.photo) {
    const data = await client.downloadMedia(media.photo, {
      sizeType,
      start,
      end,
    });

    return {
      mimeType: 'image/jpeg',
      fullSize: undefined,
      data,
    };
  }

  if (media.className === 'MessageMediaDocument' && media.document) {
    const data = await client.downloadMedia(media.document, {
      sizeType,
      start,
      end,
    });

    return {
      mimeType: media.document.mimeType || 'application/octet-stream',
      fullSize: Number(media.document.size) || undefined,
      data,
    };
  }

  return undefined;
}

export async function downloadProfileMedia(client, { peerId, isBig }) {
  const entity = await client.getEntity(peerId);
  const data = await client.downloadProfilePhoto(entity, { isBig });

  if (!data || typeof data === 'string') {
    return undefined;
  }

  return {
    mimeType: getMimeType(data),
    fullSize: data.length || undefined,
    data,
  };
}

export function extractReplyMarkup(msg) {
  const rm = msg.replyMarkup;
  if (!rm) return null;
  if (rm.className !== 'ReplyInlineMarkup' && rm.className !== 'ReplyKeyboardMarkup') return null;

  const rows = (rm.rows || []).map((row) => ({
    buttons: (row.buttons || []).map((b) => {
      const base = { text: b.text || '' };
      switch (b.className) {
        case 'KeyboardButtonCallback':
          return { ...base, type: 'callback', data: b.data ? Buffer.from(b.data).toString('base64') : '' };
        case 'KeyboardButtonUrl':
          return { ...base, type: 'url', url: b.url };
        case 'KeyboardButtonSwitchInline':
          return { ...base, type: 'switch_inline', query: b.query, sameBot: !!b.samePeer };
        case 'KeyboardButtonWebView':
        case 'KeyboardButtonSimpleWebView':
          return { ...base, type: 'webview', url: b.url };
        case 'KeyboardButtonGame':
          return { ...base, type: 'game' };
        case 'KeyboardButtonBuy':
          return { ...base, type: 'buy' };
        default:
          return { ...base, type: 'other', className: b.className };
      }
    }),
  }));

  return {
    kind: rm.className === 'ReplyInlineMarkup' ? 'inline' : 'keyboard',
    rows,
  };
}

export function resolveFromName(senderEntity, fallbackPeer) {
  if (senderEntity) {
    const name = [senderEntity.firstName, senderEntity.lastName].filter(Boolean).join(' ').trim();
    if (name) return name;
    if (senderEntity.username) return '@' + senderEntity.username;
    if (senderEntity.title) return senderEntity.title;
  }
  return null;
}

export { Api, NewMessage, EditedMessage };
