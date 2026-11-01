import { GET } from './api.js';

// Small cache for data many pages need.
export const store = {
  user: null,
  connectors: null,
  connections: null,
  brandKits: null,
  meta: null,
  async connectorsList() { if (!this.connectors) this.connectors = (await GET('/api/connectors')).connectors; return this.connectors; },
  async connectionsList(force = false) { if (!this.connections || force) this.connections = (await GET('/api/connections')).connections; return this.connections; },
  async brandKitList(force = false) { if (!this.brandKits || force) this.brandKits = (await GET('/api/brand-kits')).brandKits; return this.brandKits; },
  async metaInfo(force = false) { if (!this.meta || force) this.meta = await GET('/api/meta'); return this.meta; },
  connector(id) { return (this.connectors || []).find((c) => c.id === id) || { id, name: id, color: '#666', roles: {}, limits: {} }; },
  invalidate() { this.connections = null; this.brandKits = null; },
};
