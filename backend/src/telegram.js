const API = 'https://api.telegram.org';

export class BotApi {
  constructor(token) {
    if (!token) throw new Error('BOT_TOKEN is required');
    this.token = token;
    this.base = `${API}/bot${token}`;
  }

  async call(method, params = {}, { timeoutMs } = {}) {
    const ac = new AbortController();
    const to = timeoutMs ? setTimeout(() => ac.abort(), timeoutMs) : null;
    try {
      const res = await fetch(`${this.base}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: ac.signal,
      });
      const data = await res.json();
      if (!data.ok) throw new Error(`TG ${method}: ${data.description || res.status}`);
      return data.result;
    } finally {
      if (to) clearTimeout(to);
    }
  }

  getMe() { return this.call('getMe'); }

  getUpdates({ offset, timeout = 30 }) {
    return this.call(
      'getUpdates',
      { offset, timeout, allowed_updates: ['message', 'edited_message', 'channel_post', 'callback_query'] },
      { timeoutMs: (timeout + 5) * 1000 },
    );
  }

  sendMessage(chatId, text, extra = {}) {
    return this.call('sendMessage', { chat_id: chatId, text, ...extra });
  }

  fileUrl(filePath) {
    return `${API}/file/bot${this.token}/${filePath}`;
  }

  getFile(fileId) { return this.call('getFile', { file_id: fileId }); }
}
