import { TelegramClient, Api } from 'telegram';
import bigInt from 'big-integer';
import { Logger, LogLevel } from 'telegram/extensions/Logger.js';
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
    floodSleepThreshold: 120,
    // GramJS calls canSend() on the logger in its error paths, so a plain
    // object here turns every network hiccup into an uncaught TypeError.
    baseLogger: new Logger(LogLevel.ERROR),
  });

  try {
    await client.start({
      botAuthToken: botToken,
      onError: (err) => console.error('[mtproto]', err),
    });
  } catch (err) {
    // Otherwise the half-started client keeps reconnecting in the background.
    await client.destroy().catch(() => {});
    throw err;
  }

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

const DOWNLOAD_PART_SIZE = 512 * 1024;
const MEDIA_CACHE_TTL_MS = 10 * 60 * 1000;
const MEDIA_CACHE_MAX = 200;
const mediaCache = new Map();

// Progressive video playback requests the same message once per 512 KB part,
// so keep the resolved media around instead of refetching it every time.
async function getCachedMessageMedia(client, chatId, messageId) {
  const key = `${chatId}:${messageId}`;
  const cached = mediaCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.media;
  }

  const entity = await client.getEntity(chatId);
  const result = await client.getMessages(entity, { ids: [Number(messageId)] });
  const message = Array.isArray(result) ? result[0] : result;
  const media = message?.media;

  if (media) {
    mediaCache.delete(key);
    mediaCache.set(key, { media, expiresAt: Date.now() + MEDIA_CACHE_TTL_MS });
    if (mediaCache.size > MEDIA_CACHE_MAX) {
      mediaCache.delete(mediaCache.keys().next().value);
    }
  }

  return media;
}

function pickDocumentThumb(document) {
  const thumbs = (document.thumbs || []).filter((thumb) => (
    thumb.className === 'PhotoSize' || thumb.className === 'PhotoSizeProgressive'
  ));
  if (!thumbs.length) return undefined;

  const getSize = (thumb) => (thumb.className === 'PhotoSizeProgressive'
    ? Math.max(...thumb.sizes)
    : thumb.size);
  return thumbs.sort((a, b) => getSize(b) - getSize(a))[0];
}

async function downloadRange(client, media, fullSize, start, end) {
  const from = Math.max(0, start);
  const to = Math.min(end ?? fullSize - 1, fullSize - 1);
  if (to < from) return Buffer.alloc(0);

  // upload.getFile wants part-aligned offsets, so fetch whole parts and trim.
  const alignedStart = Math.floor(from / DOWNLOAD_PART_SIZE) * DOWNLOAD_PART_SIZE;
  const partsCount = Math.ceil((to + 1 - alignedStart) / DOWNLOAD_PART_SIZE);
  const parts = [];

  for await (const chunk of client.iterDownload({
    file: media,
    offset: bigInt(alignedStart),
    requestSize: DOWNLOAD_PART_SIZE,
    limit: partsCount,
    fileSize: bigInt(fullSize),
  })) {
    parts.push(chunk);
  }

  return Buffer.concat(parts).subarray(from - alignedStart, to - alignedStart + 1);
}

export async function downloadMessageMedia(client, { chatId, messageId, sizeType, start, end }) {
  const media = await getCachedMessageMedia(client, chatId, messageId);

  if (!media) {
    return undefined;
  }

  if (media.className === 'MessageMediaPhoto' && media.photo) {
    const sized = sizeType ? await client.downloadMedia(media, { thumb: sizeType }) : undefined;
    const data = sized?.length ? sized : await client.downloadMedia(media, {});

    return {
      mimeType: 'image/jpeg',
      fullSize: undefined,
      data,
    };
  }

  if (media.className === 'MessageMediaDocument' && media.document) {
    const { document } = media;
    const fullSize = Number(document.size) || 0;

    if (sizeType) {
      const thumb = pickDocumentThumb(document);
      if (!thumb) return undefined;

      return {
        mimeType: 'image/jpeg',
        fullSize: undefined,
        data: await client.downloadMedia(media, { thumb }),
      };
    }

    const isRange = start !== undefined && Number.isFinite(start) && fullSize > 0;
    const data = isRange
      ? await downloadRange(client, media, fullSize, start, end)
      : await client.downloadMedia(media, {});

    return {
      mimeType: document.mimeType || 'application/octet-stream',
      fullSize: fullSize || undefined,
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
