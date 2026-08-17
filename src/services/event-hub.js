export class EventHub {
  constructor() {
    this.listeners = new Map();
  }

  publish(sessionId, type, data) {
    for (const listener of this.listeners.get(sessionId) || []) {
      listener({ type, data, at: new Date().toISOString() });
    }
  }

  subscribe(sessionId, listener) {
    const listeners = this.listeners.get(sessionId) || new Set();
    listeners.add(listener);
    this.listeners.set(sessionId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(sessionId);
    };
  }
}
