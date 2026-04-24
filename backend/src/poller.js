import { runTx, getMeta, setMeta, upsertChat, insertMessage, touchChatLastMsg } from './db.js';

const detectMedia = (m) => {
  if (m.photo) {
    const best = m.photo[m.photo.length - 1];
    return { type: 'photo', fileId: best.file_id, meta: { w: best.width, h: best.height } };
  }
  if (m.video) return { type: 'video', fileId: m.video.file_id, meta: { duration: m.video.duration, w: m.video.width, h: m.video.height, mime: m.video.mime_type } };
  if (m.animation) return { type: 'animation', fileId: m.animation.file_id, meta: { duration: m.animation.duration, w: m.animation.width, h: m.animation.height, mime: m.animation.mime_type } };
  if (m.voice) return { type: 'voice', fileId: m.voice.file_id, meta: { duration: m.voice.duration, mime: m.voice.mime_type } };
  if (m.audio) return { type: 'audio', fileId: m.audio.file_id, meta: { duration: m.audio.duration, title: m.audio.title, performer: m.audio.performer, mime: m.audio.mime_type } };
  if (m.document) return { type: 'document', fileId: m.document.file_id, meta: { name: m.document.file_name, mime: m.document.mime_type, size: m.document.file_size } };
  if (m.sticker) return { type: 'sticker', fileId: m.sticker.file_id, meta: { emoji: m.sticker.emoji, w: m.sticker.width, h: m.sticker.height, isAnimated: m.sticker.is_animated, isVideo: m.sticker.is_video } };
  if (m.video_note) return { type: 'video_note', fileId: m.video_note.file_id, meta: { duration: m.video_note.duration } };
  if (m.location) return { type: 'location', fileId: null, meta: { lat: m.location.latitude, lon: m.location.longitude } };
  if (m.contact) return { type: 'contact', fileId: null, meta: { phone: m.contact.phone_number, firstName: m.contact.first_name, lastName: m.contact.last_name } };
  return { type: null, fileId: null, meta: null };
};

const chatRow = (c) => ({
  id: c.id,
  type: c.type,
  title: c.title || null,
  username: c.username || null,
  first_name: c.first_name || null,
  last_name: c.last_name || null,
  photo_file_id: null,
  updated_at: Math.floor(Date.now() / 1000),
});

const msgPreview = (m) => {
  if (m.text) return m.text.slice(0, 200);
  if (m.caption) return m.caption.slice(0, 200);
  const { type } = detectMedia(m);
  return type ? `[${type}]` : '[message]';
};

export class Poller {
  constructor({ api, botId, onEvent }) {
    this.api = api;
    this.botId = botId;
    this.onEvent = onEvent || (() => {});
    this.running = false;
    this.offset = Number(getMeta('update_offset') || 0) || undefined;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.loop();
  }

  stop() { this.running = false; }

  async loop() {
    while (this.running) {
      try {
        const updates = await this.api.getUpdates({ offset: this.offset, timeout: 30 });
        if (updates.length) {
          runTx(() => {
            for (const u of updates) this.handleUpdate(u);
          });
          this.offset = updates[updates.length - 1].update_id + 1;
          setMeta('update_offset', this.offset);
        }
      } catch (err) {
        if (!this.running) break;
        console.error('[poller]', err.message);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  handleUpdate(u) {
    const m = u.message || u.edited_message || u.channel_post || u.edited_channel_post;
    if (!m) return;

    upsertChat(chatRow(m.chat));

    if (m.from && m.from.id !== m.chat.id) {
      upsertChat(chatRow({ ...m.from, type: 'private' }));
    }

    const media = detectMedia(m);
    const isOutgoing = m.from && m.from.id === this.botId ? 1 : 0;
    const fromName = m.from ? [m.from.first_name, m.from.last_name].filter(Boolean).join(' ') || m.from.username || null : null;

    const row = {
      id: m.message_id,
      chat_id: m.chat.id,
      date: m.date,
      from_id: m.from ? m.from.id : null,
      from_name: fromName,
      is_outgoing: isOutgoing,
      text: m.text || m.caption || null,
      media_type: media.type,
      media_file_id: media.fileId,
      media_meta: media.meta ? JSON.stringify(media.meta) : null,
      reply_to_id: m.reply_to_message ? m.reply_to_message.message_id : null,
      raw: JSON.stringify(m),
    };

    insertMessage(row);
    touchChatLastMsg({
      id: m.message_id,
      date: m.date,
      text: msgPreview(m),
      is_outgoing: isOutgoing,
      chat_id: m.chat.id,
    });

    this.onEvent({ type: 'message', chatId: m.chat.id, message: row });
  }
}
