export class EventHub {
  constructor() {
    this.clients = new Set();
  }

  addClient(res, filter = {}) {
    const entry = { res, filter };
    this.clients.add(entry);
    res.on('close', () => this.clients.delete(entry));
  }

  broadcast(event) {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const { res, filter } of this.clients) {
      if (filter.botId && String(event.botId) !== String(filter.botId)) {
        continue;
      }

      try { res.write(data); } catch {}
    }
  }
}
