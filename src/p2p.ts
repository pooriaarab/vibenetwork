/**
 * Live P2P discovery over the hyperswarm DHT — no central server.
 * Barrel re-export: implementation lives in sibling modules.
 */
export { TOPIC_PREFIX, leagueTopic } from './p2p-handshake.js';
export type { PeerHello } from './p2p-handshake.js';
export { LIVE_NOTICE, serializeHandshake, parseHandshake } from './p2p-handshake.js';
export type { StoredPeer } from './p2p-peers.js';
export { loadPeers, recordPeer, recordPeerMessage } from './p2p-peers.js';
export type { NotifySink, DiscoveryOptions, DiscoverySession } from './p2p-discovery.js';
export { startDiscovery, randomTopic } from './p2p-discovery.js';
