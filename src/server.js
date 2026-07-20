#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const tls = require('tls');
const { URL } = require('url');

const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = process.env.SIFTLANE_PUBLIC_DIR || path.join(ROOT_DIR, 'public');
const DATA_DIR = process.env.SIFTLANE_DATA_DIR || path.join(ROOT_DIR, 'data');
const STATE_PATH = path.join(DATA_DIR, 'state.json');
const CONFIG_PATH = path.join(DATA_DIR, 'sing-box.json');
const TEMP_DIR = path.join(DATA_DIR, 'tmp');
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TEST_TICK_MS = 10 * 1000;
const TEST_TIMEOUT_MS = 10 * 1000;
const SPEEDTEST_SAMPLE_COUNT = 2;
const SPEEDTEST_SAMPLE_INTERVAL_MS = 100;
const SPEEDTEST_CONCURRENCY = 5;
const SPEEDTEST_WARMUP_MS = 1000;
const SPEEDTEST_RECHECK_CONCURRENCY = 1;
const AUTO_DISABLE_FAIL_THRESHOLD = 3;
const BEST_SWITCH_MIN_IMPROVEMENT_MS = 80;
const BEST_SWITCH_COOLDOWN_MS = 5 * 60 * 1000;
const CURRENT_FAIL_SWITCH_THRESHOLD = 2;
const MAX_LOG_LINES = 200;
const DEFAULT_GROUP_NAME = '默认分组';
const DEFAULT_SUBSCRIPTION_CONVERTER_URL = 'https://clawsub.7979.pp.ua/';

const sessions = new Map();
const core = {
  process: null,
  status: 'stopped',
  startedAt: null,
  lastError: null,
  logs: []
};

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const COMPACT_UUID_PATTERN = /(?:^|[^0-9a-f])([0-9a-f]{32})(?:[^0-9a-f]|$)/i;

let testing = false;
let suppressCanceledLogsUntil = 0;
let syncingSubscriptions = false;
let state = loadState();

function createId(prefix = '') {
  return `${prefix}${crypto.randomBytes(8).toString('hex')}`;
}

function toInt(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeUuid(value) {
  const text = normalizeString(value);
  if (!text) return '';
  const match = text.match(UUID_PATTERN);
  if (match) return match[0].toLowerCase();
  const compactMatch = text.match(COMPACT_UUID_PATTERN);
  if (!compactMatch) return '';
  const compact = compactMatch[1].toLowerCase();
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

function normalizeGroupName(value) {
  return normalizeString(value) || DEFAULT_GROUP_NAME;
}

function stripAnsi(value) {
  return String(value || '').replace(/\u001b\[[0-9;]*m/g, '');
}

function defaultState() {
  return {
    version: 1,
    settings: {
      webHost: process.env.SIFTLANE_HOST || '0.0.0.0',
      webPort: toInt(process.env.SIFTLANE_PORT || process.env.PORT, 51888),
      proxyListenHost: '0.0.0.0',
      httpPort: 18999,
      socksPort: 18998,
      singBoxPath: process.env.SING_BOX_PATH || 'sing-box',
      testUrl: 'https://www.gstatic.com/generate_204',
      testIntervalSec: 300,
      switchPolicy: 'best',
      switchMode: 'manual',
      manualNodeId: null,
      autoSwitchIntervalMin: 10,
      activeGroupId: null,
      lastSwitchAt: null,
      lastTestAt: null,
      subscriptionConverterUrl: DEFAULT_SUBSCRIPTION_CONVERTER_URL,
      passwordHash: null
    },
    nodes: [],
    groups: []
  };
}

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function loadState() {
  ensureDirs();
  let loaded = null;
  try {
    if (fs.existsSync(STATE_PATH)) {
      loaded = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    }
  } catch {
    loaded = null;
  }
  return normalizeState({
    ...defaultState(),
    ...(loaded || {}),
    settings: {
      ...defaultState().settings,
      ...(loaded?.settings || {})
    }
  });
}

function saveState() {
  ensureDirs();
  state = normalizeState(state);
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

function normalizeState(input) {
  const next = {
    version: 1,
    settings: {
      ...defaultState().settings,
      ...(input?.settings || {})
    },
    nodes: Array.isArray(input?.nodes) ? input.nodes.map(normalizeNode).filter(Boolean) : [],
    groups: Array.isArray(input?.groups) ? input.groups.map(normalizeGroup).filter(Boolean) : []
  };

  next.settings.webHost = process.env.SIFTLANE_HOST || normalizeString(next.settings.webHost) || '0.0.0.0';
  next.settings.webPort = toInt(process.env.SIFTLANE_PORT || process.env.PORT || next.settings.webPort, 51888);
  next.settings.proxyListenHost = normalizeString(next.settings.proxyListenHost) || '0.0.0.0';
  next.settings.httpPort = toInt(next.settings.httpPort, 18999);
  next.settings.socksPort = toInt(next.settings.socksPort, 18998);
  next.settings.singBoxPath = process.env.SING_BOX_PATH || normalizeString(next.settings.singBoxPath) || 'sing-box';
  next.settings.testUrl = normalizeString(next.settings.testUrl) || 'https://www.gstatic.com/generate_204';
  if (next.settings.testUrl === 'http://www.gstatic.com/generate_204' || next.settings.testUrl === 'https://api.ipify.org') {
    next.settings.testUrl = 'https://www.gstatic.com/generate_204';
  }
  next.settings.testIntervalSec = Math.min(86400, Math.max(30, toInt(next.settings.testIntervalSec, 300)));
  next.settings.switchPolicy = ['best', 'random'].includes(next.settings.switchPolicy) ? next.settings.switchPolicy : 'best';
  next.settings.switchMode = ['manual', 'auto'].includes(next.settings.switchMode) ? next.settings.switchMode : 'manual';
  next.settings.manualNodeId = normalizeString(next.settings.manualNodeId) || null;
  next.settings.autoSwitchIntervalMin = Math.min(1440, Math.max(1, toInt(next.settings.autoSwitchIntervalMin, 10)));
  next.settings.passwordHash = normalizeString(next.settings.passwordHash) || null;
  next.settings.lastSwitchAt = normalizeIso(next.settings.lastSwitchAt);
  next.settings.lastTestAt = normalizeIso(next.settings.lastTestAt);
  next.settings.subscriptionConverterUrl = typeof next.settings.subscriptionConverterUrl === 'string'
    ? normalizeString(next.settings.subscriptionConverterUrl)
    : DEFAULT_SUBSCRIPTION_CONVERTER_URL;

  syncGroups(next);
  if (next.settings.manualNodeId && !next.nodes.some((node) => node.id === next.settings.manualNodeId)) {
    next.settings.manualNodeId = null;
  }
  return next;
}

function normalizeIso(value) {
  const text = normalizeString(value);
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  const text = normalizeString(value).toLowerCase();
  if (!text) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return fallback;
}

function firstString(...values) {
  for (const value of values) {
    if (value && typeof value === 'object') continue;
    const text = normalizeString(value);
    if (text) return text;
  }
  return '';
}

function normalizePositiveInt(value, fallback = 0) {
  const parsed = toInt(value, fallback);
  return parsed > 0 ? parsed : fallback;
}

function normalizeAlpn(value) {
  const items = Array.isArray(value) ? value : normalizeString(value).split(',');
  return items.map((item) => normalizeString(item)).filter(Boolean);
}

function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function headerValue(headers, name) {
  const source = objectOrEmpty(headers);
  const direct = firstString(source[name], source[name.toLowerCase()]);
  if (direct) return direct;
  const found = Object.keys(source).find((key) => key.toLowerCase() === name.toLowerCase());
  return found ? normalizeString(source[found]) : '';
}

function normalizeWsEarlyData(pathValue, explicitEarlyData = 0) {
  let wsPath = normalizeString(pathValue);
  let maxEarlyData = normalizePositiveInt(explicitEarlyData, 0);
  if (!wsPath) return { path: '', maxEarlyData };

  try {
    const parsed = new URL(wsPath.startsWith('/') ? `ws://siftlane.local${wsPath}` : `ws://siftlane.local/${wsPath}`);
    const ed = normalizePositiveInt(parsed.searchParams.get('ed') || parsed.searchParams.get('max_early_data'), 0);
    if (!maxEarlyData && ed) maxEarlyData = ed;
    parsed.searchParams.delete('ed');
    parsed.searchParams.delete('max_early_data');
    wsPath = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    const match = wsPath.match(/(?:^|[?&])(?:ed|max_early_data)=(\d+)/i);
    if (!maxEarlyData && match) maxEarlyData = normalizePositiveInt(match[1], 0);
    wsPath = wsPath
      .replace(/([?&])(?:ed|max_early_data)=\d+(&?)/ig, (full, prefix, suffix) => (prefix === '?' && suffix ? '?' : suffix ? prefix : ''))
      .replace(/[?&]$/, '');
  }

  if (wsPath && !wsPath.startsWith('/')) wsPath = `/${wsPath}`;
  return { path: wsPath, maxEarlyData };
}

function normalizeNode(node) {
  if (!node || typeof node !== 'object') return null;
  const id = normalizeString(node.id) || createId('node_');
  const type = normalizeString(node.type).toLowerCase();
  const server = normalizeString(node.server);
  const port = toInt(node.port || node.server_port, 0);
  if (!id || !type || !server || !port) return null;

  const tlsConfig = objectOrEmpty(node.tls);
  const realityConfig = objectOrEmpty(tlsConfig.reality);
  const utlsConfig = objectOrEmpty(tlsConfig.utls);
  const transportConfig = objectOrEmpty(node.transport);
  const headers = objectOrEmpty(transportConfig.headers || node.headers);
  const rawSecurity = normalizeString(node.security || node.cipher || node.scy).toLowerCase();
  const normalizedSecurity = type === 'vmess' && ['tls', 'reality'].includes(rawSecurity)
    ? firstString(node.cipher, node.scy, 'auto').toLowerCase()
    : rawSecurity;
  const rawTransport = transportConfig.type || (typeof node.transport === 'string' ? node.transport : '') || node.network;
  const transport = normalizeString(rawTransport).toLowerCase();
  const wsEarlyData = normalizeWsEarlyData(
    firstString(node.wsPath, node.path, transportConfig.path),
    node.maxEarlyData ?? node.max_early_data ?? transportConfig.max_early_data ?? node.ed
  );
  const hasTlsObject = node.tls && typeof node.tls === 'object';
  const tlsEnabled = normalizeBoolean(
    tlsConfig.enabled ?? node.tlsEnabled ?? node.tls_enabled ?? (typeof node.tls === 'boolean' ? node.tls : ''),
    hasTlsObject || rawSecurity === 'tls' || rawSecurity === 'reality'
  );
  const obfsConfig = objectOrEmpty(node.obfs);
  const congestionControl = firstString(node.congestionControl, node.congestion_control, node.congestion);

  return {
    id,
    name: normalizeString(node.name) || server,
    type,
    server,
    port,
    group: normalizeGroupName(node.group),
    enabled: node.enabled !== false,
    autoDisabled: Boolean(node.autoDisabled),
    status: ['up', 'down', 'unknown'].includes(node.status) ? node.status : 'unknown',
    latencyMs: Number.isFinite(Number(node.latencyMs)) ? Number(node.latencyMs) : null,
    lastTestAt: normalizeIso(node.lastTestAt),
    error: normalizeString(node.error) || null,
    failCount: Math.max(0, toInt(node.failCount, 0)),
    successCount: Math.max(0, toInt(node.successCount, 0)),
    username: normalizeString(node.username),
    password: normalizeString(node.password),
    method: normalizeString(node.method),
    plugin: normalizeString(node.plugin),
    pluginOpts: normalizeString(node.pluginOpts || node.plugin_opts || node.pluginOptions),
    uuid: normalizeUuid(node.uuid),
    alterId: toInt(node.alterId, 0),
    security: normalizedSecurity,
    tls: tlsEnabled,
    sni: firstString(node.sni, node.serverName, node.server_name, tlsConfig.server_name),
    alpn: normalizeAlpn(node.alpn ?? tlsConfig.alpn),
    insecure: normalizeBoolean(node.insecure ?? tlsConfig.insecure, false),
    transport,
    wsPath: wsEarlyData.path,
    wsHost: firstString(node.wsHost, node.host, headerValue(headers, 'Host')),
    maxEarlyData: wsEarlyData.maxEarlyData,
    earlyDataHeaderName: firstString(node.earlyDataHeaderName, node.early_data_header_name, transportConfig.early_data_header_name),
    serviceName: firstString(node.serviceName, node.service_name, transportConfig.service_name),
    pbk: firstString(node.pbk, node.publicKey, node.public_key, realityConfig.public_key),
    sid: firstString(node.sid, node.shortId, node.short_id, realityConfig.short_id),
    spx: firstString(node.spx, node.spiderX, node.spider_x, realityConfig.spider_x),
    flow: normalizeString(node.flow),
    fingerprint: firstString(node.fingerprint, node.fp, utlsConfig.fingerprint),
    packetEncoding: firstString(node.packetEncoding, node.packet_encoding),
    obfs: firstString(obfsConfig.type, node.obfs),
    obfsPassword: firstString(obfsConfig.password, node.obfsPassword, node.obfs_password),
    upMbps: normalizePositiveInt(node.upMbps ?? node.up_mbps, 0),
    downMbps: normalizePositiveInt(node.downMbps ?? node.down_mbps, 0),
    heartbeat: normalizeString(node.heartbeat),
    congestionControl,
    udpRelayMode: firstString(node.udpRelayMode, node.udp_relay_mode),
    sourceType: normalizeString(node.sourceType) || 'manual',
    sourceGroupId: normalizeString(node.sourceGroupId) || null,
    sourceSubscriptionId: normalizeString(node.sourceSubscriptionId || node.subscriptionId) || null,
    sourceUrl: normalizeString(node.sourceUrl) || null,
    sourceKey: normalizeString(node.sourceKey) || null
  };
}

function inferSubscriptionName(url) {
  const text = normalizeString(url);
  if (!text) return '订阅';
  try {
    const parsed = new URL(text);
    return parsed.hostname || '订阅';
  } catch {
    return text.length > 32 ? text.slice(0, 32) + '...' : text;
  }
}

function normalizeSubscription(subscription, fallback = {}) {
  const source = subscription && typeof subscription === 'object' ? subscription : {};
  const url = normalizeString(source.url || source.subscriptionUrl || fallback.url);
  if (!url) return null;
  return {
    id: normalizeString(source.id || fallback.id) || createId('sub_'),
    name: normalizeString(source.name || fallback.name) || inferSubscriptionName(url),
    url,
    enabled: source.enabled !== false,
    lastSyncAt: normalizeIso(source.lastSyncAt || source.subscriptionLastSyncAt || fallback.lastSyncAt),
    lastError: normalizeString(source.lastError || source.subscriptionLastError || fallback.lastError) || null,
    lastCount: Math.max(0, toInt(source.lastCount ?? source.subscriptionLastCount ?? fallback.lastCount, 0))
  };
}

function latestSubscriptionSyncAt(subscriptions) {
  let latest = 0;
  for (const subscription of subscriptions || []) {
    const ms = Date.parse(subscription.lastSyncAt || '');
    if (Number.isFinite(ms) && ms > latest) latest = ms;
  }
  return latest ? new Date(latest).toISOString() : null;
}

function normalizeGroupSubscriptions(group) {
  const subscriptions = [];
  const seen = new Set();
  const add = (subscription, fallback = {}) => {
    const item = normalizeSubscription(subscription, fallback);
    if (!item || seen.has(item.id) || seen.has(item.url)) return;
    seen.add(item.id);
    seen.add(item.url);
    subscriptions.push(item);
  };

  if (Array.isArray(group.subscriptions)) {
    for (const subscription of group.subscriptions) add(subscription);
  }

  const legacyUrl = normalizeString(group.subscriptionUrl);
  if (legacyUrl && !seen.has(legacyUrl)) {
    add({
      url: legacyUrl,
      name: normalizeString(group.subscriptionName) || inferSubscriptionName(legacyUrl),
      lastSyncAt: group.subscriptionLastSyncAt,
      lastError: group.subscriptionLastError,
      lastCount: group.subscriptionLastCount
    });
  }

  return subscriptions;
}

function normalizeGroup(group) {
  if (!group || typeof group !== 'object') return null;
  const id = normalizeString(group.id) || createId('group_');
  const name = normalizeGroupName(group.name);
  if (!id || !name) return null;
  const subscriptions = normalizeGroupSubscriptions(group);
  const subscriptionLastCount = subscriptions.length
    ? subscriptions.reduce((sum, subscription) => sum + Math.max(0, toInt(subscription.lastCount, 0)), 0)
    : Math.max(0, toInt(group.subscriptionLastCount, 0));
  const subscriptionError = subscriptions.find((subscription) => subscription.lastError)?.lastError || normalizeString(group.subscriptionLastError) || null;
  return {
    id,
    name,
    nodeIds: Array.isArray(group.nodeIds) ? [...new Set(group.nodeIds.map(normalizeString).filter(Boolean))] : [],
    selectedNodeId: normalizeString(group.selectedNodeId) || null,
    subscriptionUrl: subscriptions[0]?.url || '',
    subscriptionUpdateIntervalMin: normalizeSubscriptionUpdateInterval(group.subscriptionUpdateIntervalMin || group.intervalMin || 60),
    subscriptionLastSyncAt: normalizeIso(group.subscriptionLastSyncAt) || latestSubscriptionSyncAt(subscriptions),
    subscriptionLastError: subscriptionError,
    subscriptionLastCount,
    subscriptions
  };
}

function syncGroups(targetState = state) {
  const existingByName = new Map((targetState.groups || []).map((group) => [group.name, group]));
  const nodeIds = new Set(targetState.nodes.map((node) => node.id));
  const groups = [];
  const seenNames = new Set();

  for (const node of targetState.nodes) {
    const groupName = normalizeGroupName(node.group);
    if (seenNames.has(groupName)) continue;
    seenNames.add(groupName);
    const existing = existingByName.get(groupName);
    const ids = targetState.nodes.filter((item) => item.group === groupName).map((item) => item.id);
    groups.push({
      ...(existing || {}),
      id: existing?.id || createId('group_'),
      name: groupName,
      nodeIds: ids,
      selectedNodeId: ids.includes(existing?.selectedNodeId) ? existing.selectedNodeId : (ids[0] || null)
    });
  }

  if (!seenNames.has(DEFAULT_GROUP_NAME)) {
    const existing = existingByName.get(DEFAULT_GROUP_NAME);
    groups.push({
      ...(existing || {}),
      id: existing?.id || createId('group_'),
      name: DEFAULT_GROUP_NAME,
      nodeIds: [],
      selectedNodeId: null
    });
    seenNames.add(DEFAULT_GROUP_NAME);
  }

  for (const group of targetState.groups || []) {
    if (seenNames.has(group.name)) continue;
    const ids = group.nodeIds.filter((id) => nodeIds.has(id));
    groups.push({
      ...group,
      nodeIds: ids,
      selectedNodeId: ids.includes(group.selectedNodeId) ? group.selectedNodeId : (ids[0] || null)
    });
  }

  targetState.groups = groups;
  if (!targetState.settings.activeGroupId || !groups.some((group) => group.id === targetState.settings.activeGroupId)) {
    targetState.settings.activeGroupId = groups[0]?.id || null;
  }
}

function nodeUsable(node) {
  return Boolean(node && node.enabled !== false && !node.autoDisabled);
}

function nodeConfigError(node) {
  const type = normalizeString(node?.type).toLowerCase();
  if (['vmess', 'vless', 'tuic'].includes(type) && !normalizeUuid(node?.uuid)) {
    return 'UUID invalid';
  }
  return '';
}

function nodeConfigurable(node) {
  return Boolean(nodeUsable(node) && !nodeConfigError(node));
}

function getGroupNodes(group) {
  const ids = new Set(group?.nodeIds || []);
  return state.nodes.filter((node) => ids.has(node.id));
}

function chooseGroupNode(group) {
  const usable = getGroupNodes(group).filter(nodeConfigurable);
  if (!usable.length) return null;
  if (usable.some((node) => node.id === group.selectedNodeId)) {
    return usable.find((node) => node.id === group.selectedNodeId);
  }
  if (state.settings.switchPolicy === 'random') {
    return usable[Math.floor(Math.random() * usable.length)];
  }
  const tested = usable
    .filter((node) => node.status === 'up' && Number.isFinite(Number(node.latencyMs)))
    .sort((a, b) => Number(a.latencyMs) - Number(b.latencyMs));
  return tested[0] || usable[0];
}

function applyGroupSelections() {
  for (const group of state.groups) {
    const selected = chooseGroupNode(group);
    group.selectedNodeId = selected?.id || null;
  }
  const active = state.groups.find((group) => group.id === state.settings.activeGroupId) || state.groups[0] || null;
  state.settings.activeGroupId = active?.id || null;
}

function getUsableNodes() {
  return state.nodes.filter(nodeConfigurable);
}

function getActiveGroup() {
  return state.groups.find((group) => group.id === state.settings.activeGroupId) || state.groups[0] || null;
}

function getManualNode() {
  const selected = state.nodes.find((node) => node.id === state.settings.manualNodeId);
  return nodeConfigurable(selected) ? selected : (getUsableNodes()[0] || null);
}

function getCurrentOutboundNode() {
  if (state.settings.switchMode === 'auto') {
    const activeGroup = getActiveGroup();
    return activeGroup ? chooseGroupNode(activeGroup) : null;
  }
  return getManualNode();
}

function getNextSwitchAt() {
  if (state.settings.switchMode !== 'auto' || core.status !== 'running') return null;
  const activeGroup = getActiveGroup();
  if (!activeGroup || !getGroupNodes(activeGroup).some(nodeConfigurable)) return null;
  const intervalMs = state.settings.switchPolicy === 'best'
    ? BEST_SWITCH_COOLDOWN_MS
    : state.settings.autoSwitchIntervalMin * 60 * 1000;
  const last = state.settings.lastSwitchAt ? Date.parse(state.settings.lastSwitchAt) : Date.now();
  if (!Number.isFinite(last)) return null;
  return new Date(last + intervalMs).toISOString();
}

function rotateActiveGroupSelection() {
  const group = getActiveGroup();
  if (!group) return null;
  const usable = getGroupNodes(group).filter(nodeConfigurable);
  if (!usable.length) {
    group.selectedNodeId = null;
    return null;
  }
  const currentIndex = usable.findIndex((node) => node.id === group.selectedNodeId);
  const next = usable[(currentIndex + 1 + usable.length) % usable.length] || usable[0];
  group.selectedNodeId = next.id;
  return next;
}

function latencyValue(node) {
  const value = Number(node?.latencyMs);
  return Number.isFinite(value) ? value : null;
}

function getBestLatencyNode(nodes, excludeId = null) {
  return (nodes || [])
    .filter((node) => nodeConfigurable(node) && node.id !== excludeId && node.status === 'up' && latencyValue(node) !== null)
    .sort((a, b) => latencyValue(a) - latencyValue(b))[0] || null;
}

function decideBestSwitch({ nodes, selectedNodeId, lastSwitchAt, nowMs = Date.now() }) {
  const usable = (nodes || []).filter(nodeConfigurable);
  if (!usable.length) return null;

  const current = usable.find((node) => node.id === selectedNodeId) || null;
  if (!current) {
    const initialBest = getBestLatencyNode(usable) || usable[0];
    return initialBest ? { node: initialBest, reason: 'initial' } : null;
  }

  const failedEnough = Math.max(0, toInt(current.failCount, 0)) >= CURRENT_FAIL_SWITCH_THRESHOLD;
  if (failedEnough) {
    const failoverBest = getBestLatencyNode(usable, current.id);
    if (failoverBest) return { node: failoverBest, reason: 'current_failed' };
  }

  const best = getBestLatencyNode(usable);
  if (!best || best.id === current.id) return null;

  const last = lastSwitchAt ? Date.parse(lastSwitchAt) : 0;
  const cooledDown = !Number.isFinite(last) || last <= 0 || nowMs - last >= BEST_SWITCH_COOLDOWN_MS;
  if (!cooledDown) return null;

  const currentLatency = latencyValue(current);
  const bestLatency = latencyValue(best);
  if (currentLatency === null || bestLatency === null) return null;
  if (bestLatency + BEST_SWITCH_MIN_IMPROVEMENT_MS <= currentLatency) {
    return { node: best, reason: 'better_latency' };
  }
  return null;
}

function switchActiveGroupToBest(nowMs = Date.now()) {
  const group = getActiveGroup();
  if (!group) return null;
  const decision = decideBestSwitch({
    nodes: getGroupNodes(group),
    selectedNodeId: group.selectedNodeId,
    lastSwitchAt: state.settings.lastSwitchAt,
    nowMs
  });
  if (!decision?.node || decision.node.id === group.selectedNodeId) return null;
  group.selectedNodeId = decision.node.id;
  state.settings.lastSwitchAt = new Date(nowMs).toISOString();
  return decision;
}

async function runAutoSwitchIfDue() {
  if (testing || !core.process || state.settings.switchMode !== 'auto') return;
  if (state.settings.switchPolicy === 'best') {
    const before = runtimeSignature();
    const decision = switchActiveGroupToBest();
    if (!decision) return;
    saveState();
    const after = runtimeSignature();
    appendCoreLog(`自动切换到节点：${decision.node.name}`);
    if (before !== after) {
      await restartCore();
    }
    return;
  }

  const intervalMs = state.settings.autoSwitchIntervalMin * 60 * 1000;
  const last = state.settings.lastSwitchAt ? Date.parse(state.settings.lastSwitchAt) : 0;
  if (!Number.isFinite(last) || last <= 0) {
    state.settings.lastSwitchAt = new Date().toISOString();
    saveState();
    return;
  }
  if (Date.now() - last < intervalMs) return;

  const before = runtimeSignature();
  const selected = rotateActiveGroupSelection();
  state.settings.lastSwitchAt = new Date().toISOString();
  saveState();
  const after = runtimeSignature();
  if (selected) appendCoreLog(`自动切换到节点：${selected.name}`);
  if (selected && before !== after) {
    await restartCore();
  }
}
function runtimeSignature() {
  return JSON.stringify({
    switchMode: state.settings.switchMode,
    manualNodeId: state.settings.manualNodeId,
    autoSwitchIntervalMin: state.settings.autoSwitchIntervalMin,
    activeGroupId: state.settings.activeGroupId,
    groups: state.groups.map((group) => ({
      id: group.id,
      selectedNodeId: group.selectedNodeId,
      usableIds: getGroupNodes(group).filter(nodeConfigurable).map((node) => node.id)
    }))
  });
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 32, 'sha256').toString('hex');
  return `pbkdf2$${salt}$${hash}`;
}

function verifyPassword(password, encoded) {
  const [kind, salt, expected] = String(encoded || '').split('$');
  if (kind !== 'pbkdf2' || !salt || !expected) return false;
  const actual = crypto.pbkdf2Sync(String(password), salt, 120000, 32, 'sha256').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map((part) => {
    const index = part.indexOf('=');
    return index >= 0 ? [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1))] : ['', ''];
  }).filter(([key]) => key));
}

function isAuthenticated(req) {
  const token = parseCookies(req).siftlane_session;
  const session = token ? sessions.get(token) : null;
  if (!session || session.expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    return false;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return true;
}

function createSession(res) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS });
  res.setHeader('Set-Cookie', `siftlane_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
}

function clearSession(req, res) {
  const token = parseCookies(req).siftlane_session;
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', 'siftlane_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).length > 2 * 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('JSON 请求体无效'));
      }
    });
    req.on('error', reject);
  });
}

function publicState() {
  const currentNode = getCurrentOutboundNode();
  const startedAtMs = core.startedAt ? Date.parse(core.startedAt) : 0;
  return {
    settings: {
      ...state.settings,
      passwordHash: undefined,
      setupRequired: !state.settings.passwordHash
    },
    nodes: state.nodes,
    groups: state.groups,
    dashboard: {
      currentNode: currentNode ? {
        id: currentNode.id,
        name: currentNode.name,
        group: currentNode.group,
        status: currentNode.status,
        latencyMs: currentNode.latencyMs
      } : null,
      nextSwitchAt: getNextSwitchAt(),
      uptimeSec: core.status === 'running' && Number.isFinite(startedAtMs) && startedAtMs > 0
        ? Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000))
        : 0
    },
    core: {
      status: core.status,
      startedAt: core.startedAt,
      lastError: core.lastError,
      logs: core.logs.slice(-120)
    },
    testing,
    firewall: getFirewallState()
  };
}

function isExpectedCanceledLog(text) {
  return /operation was canceled|context canceled|connection upload closed: stream \d+ canceled by remote/i.test(text);
}

function appendCoreLog(line) {
  const text = stripAnsi(line).trim();
  if (!text || /read http request: EOF/i.test(text)) return;
  if (Date.now() < suppressCanceledLogsUntil && isExpectedCanceledLog(text)) return;
  const entry = { at: new Date().toISOString(), line: text };
  core.logs.push(entry);
  console.log(`[${entry.at}] ${text}`);
  if (core.logs.length > MAX_LOG_LINES) {
    core.logs.splice(0, core.logs.length - MAX_LOG_LINES);
  }
}

function shouldEnableTls(node) {
  return Boolean(
    node.tls ||
    node.security === 'tls' ||
    node.security === 'reality' ||
    node.sni ||
    node.pbk ||
    ['trojan', 'hysteria2', 'tuic'].includes(node.type)
  );
}

function buildTlsConfig(node) {
  if (!shouldEnableTls(node)) return null;
  const tlsConfig = {
    enabled: true,
    server_name: node.sni || node.server,
    insecure: Boolean(node.insecure)
  };

  const nodeAlpn = Array.isArray(node.alpn) ? node.alpn : normalizeAlpn(node.alpn);
  const alpn = nodeAlpn.length ? nodeAlpn : (['hysteria2', 'tuic'].includes(node.type) ? ['h3'] : []);
  if (alpn.length) tlsConfig.alpn = alpn;

  const isReality = node.security === 'reality' || Boolean(node.pbk);
  if (isReality) {
    tlsConfig.reality = {
      enabled: true,
      public_key: node.pbk
    };
    if (node.sid) tlsConfig.reality.short_id = node.sid;
  }

  if (!['hysteria2', 'tuic'].includes(node.type)) {
    const fingerprint = node.fingerprint || (isReality ? 'chrome' : '');
    if (fingerprint) {
      tlsConfig.utls = {
        enabled: true,
        fingerprint
      };
    }
  }

  return tlsConfig;
}

function buildNodeOutbound(node) {
  const outbound = {
    type: node.type,
    tag: `out-${node.id}`,
    server: node.server,
    server_port: node.port
  };

  if (node.type === 'socks') {
    outbound.version = '5';
    if (node.username) outbound.username = node.username;
    if (node.password) outbound.password = node.password;
  } else if (node.type === 'http') {
    if (node.username) outbound.username = node.username;
    if (node.password) outbound.password = node.password;
  } else if (node.type === 'shadowsocks' || node.type === 'ss') {
    outbound.type = 'shadowsocks';
    outbound.method = node.method || 'aes-256-gcm';
    outbound.password = node.password;
    const plugin = normalizeShadowsocksPlugin(node.plugin);
    if (plugin) {
      outbound.plugin = plugin;
      if (node.pluginOpts) outbound.plugin_opts = node.pluginOpts;
    }
  } else if (node.type === 'vmess') {
    const uuid = normalizeUuid(node.uuid);
    if (!uuid) return null;
    outbound.uuid = uuid;
    outbound.security = node.security && !['tls', 'reality'].includes(node.security) ? node.security : 'auto';
    outbound.alter_id = node.alterId || 0;
    outbound.packet_encoding = node.packetEncoding || 'packetaddr';
  } else if (node.type === 'vless') {
    const uuid = normalizeUuid(node.uuid);
    if (!uuid) return null;
    outbound.uuid = uuid;
    outbound.packet_encoding = node.packetEncoding || 'xudp';
    if (node.flow) outbound.flow = node.flow;
  } else if (node.type === 'trojan') {
    outbound.password = node.password;
  } else if (node.type === 'hysteria2') {
    outbound.password = node.password;
    if (node.obfs) {
      outbound.obfs = { type: node.obfs };
      if (node.obfsPassword) outbound.obfs.password = node.obfsPassword;
    }
    if (node.upMbps) outbound.up_mbps = node.upMbps;
    if (node.downMbps) outbound.down_mbps = node.downMbps;
    if (node.heartbeat) outbound.heartbeat = node.heartbeat;
  } else if (node.type === 'tuic') {
    const uuid = normalizeUuid(node.uuid);
    if (!uuid) return null;
    outbound.uuid = uuid;
    outbound.password = node.password;
    outbound.congestion_control = node.congestionControl || 'bbr';
    if (node.udpRelayMode) outbound.udp_relay_mode = node.udpRelayMode;
    if (node.heartbeat) outbound.heartbeat = node.heartbeat;
  }

  const tlsConfig = buildTlsConfig(node);
  if (tlsConfig) outbound.tls = tlsConfig;

  if (node.transport === 'ws') {
    outbound.transport = {
      type: 'ws',
      path: node.wsPath || '/',
      headers: {}
    };
    if (node.wsHost) outbound.transport.headers.Host = node.wsHost;
    if (node.maxEarlyData) outbound.transport.max_early_data = node.maxEarlyData;
    if (node.earlyDataHeaderName || node.maxEarlyData) {
      outbound.transport.early_data_header_name = node.earlyDataHeaderName || 'Sec-WebSocket-Protocol';
    }
  } else if (node.transport === 'grpc') {
    outbound.transport = {
      type: 'grpc',
      service_name: node.serviceName || ''
    };
  }

  return outbound;
}

function buildRuntimeConfig() {
  applyGroupSelections();
  const usableNodes = state.nodes.filter(nodeConfigurable);
  const outbounds = usableNodes.map(buildNodeOutbound).filter(Boolean);
  const groupOutbounds = state.groups.map((group) => {
    const usableIds = getGroupNodes(group).filter(nodeConfigurable).map((node) => node.id);
    if (!usableIds.length) return null;
    const selected = usableIds.includes(group.selectedNodeId) ? group.selectedNodeId : usableIds[0];
    return {
      type: 'selector',
      tag: `grp-${group.id}`,
      outbounds: [...new Set([selected, ...usableIds].map((id) => `out-${id}`))],
      interrupt_exist_connections: true
    };
  }).filter(Boolean);
  const activeNode = getCurrentOutboundNode();
  const activeOutbound = activeNode && nodeConfigurable(activeNode) ? `out-${activeNode.id}` : 'direct';

  return {
    log: { level: 'warn' },
    inbounds: [
      {
        type: 'http',
        tag: 'system-http',
        listen: state.settings.proxyListenHost,
        listen_port: state.settings.httpPort
      },
      {
        type: 'socks',
        tag: 'system-socks',
        listen: state.settings.proxyListenHost,
        listen_port: state.settings.socksPort
      }
    ],
    outbounds: [
      ...outbounds,
      ...groupOutbounds,
      { type: 'direct', tag: 'direct' }
    ],
    dns: {
      servers: [{ type: 'local', tag: 'dns-local' }],
      final: 'dns-local'
    },
    route: {
      rules: [
        {
          inbound: ['system-http', 'system-socks'],
          outbound: activeOutbound
        }
      ],
      auto_detect_interface: true,
      final: 'direct'
    }
  };
}

function writeCoreConfig(config = buildRuntimeConfig()) {
  ensureDirs();
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
  return CONFIG_PATH;
}

function waitForPort(port, host = '127.0.0.1', timeoutMs = 5000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ host, port });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - started >= timeoutMs) {
          reject(new Error(`等待 ${host}:${port} 启动超时`));
          return;
        }
        setTimeout(attempt, 120);
      });
    };
    attempt();
  });
}

function stopProcess(processRef, timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (!processRef || processRef.killed) {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    processRef.once('exit', finish);
    processRef.kill('SIGTERM');
    setTimeout(() => {
      if (!settled) {
        try {
          processRef.kill('SIGKILL');
        } catch {
          // best effort
        }
        finish();
      }
    }, timeoutMs).unref?.();
  });
}

async function startCore() {
  if (core.process) return publicState().core;
  const configPath = writeCoreConfig();
  const binPath = state.settings.singBoxPath;
  core.status = 'starting';
  core.lastError = null;
  const child = spawn(binPath, ['run', '-c', configPath], { windowsHide: true });
  core.process = child;
  core.startedAt = new Date().toISOString();
  child.stdout.on('data', (data) => String(data).split(/\r?\n/).forEach(appendCoreLog));
  child.stderr.on('data', (data) => String(data).split(/\r?\n/).forEach(appendCoreLog));
  child.once('error', (error) => {
    if (core.process === child) core.process = null;
    core.status = 'error';
    core.lastError = error.message;
    appendCoreLog(error.message);
  });
  child.once('close', (code, signal) => {
    if (core.process === child) core.process = null;
    core.status = code === 0 || signal === 'SIGTERM' ? 'stopped' : 'error';
    core.startedAt = null;
    if (core.status === 'error') core.lastError = `sing-box 异常退出：${code ?? signal}`;
  });
  await waitForPort(state.settings.httpPort);
  core.status = 'running';
  return publicState().core;
}

async function stopCore() {
  const processRef = core.process;
  core.process = null;
  await stopProcess(processRef);
  core.status = 'stopped';
  core.startedAt = null;
  return publicState().core;
}

async function restartCore() {
  suppressCanceledLogsUntil = Date.now() + 10000;
  appendCoreLog('配置变更，正在重启核心');
  await stopCore();
  const result = await startCore();
  suppressCanceledLogsUntil = Date.now() + 3000;
  return result;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function socksReplyMessage(code) {
  const messages = {
    1: 'SOCKS general failure',
    2: 'SOCKS connection not allowed',
    3: 'SOCKS network unreachable',
    4: 'SOCKS host unreachable',
    5: 'SOCKS connection refused',
    6: 'SOCKS TTL expired',
    7: 'SOCKS command not supported',
    8: 'SOCKS address type not supported'
  };
  return messages[code] || `SOCKS error ${code}`;
}

function normalizeProbeError(error) {
  const text = stripAnsi(error?.message || error).trim();
  const lower = text.toLowerCase();
  if (/timeout|timed out|i\/o timeout|deadline|etimedout/.test(lower)) return '请求超时';
  if (/dns|lookup|getaddrinfo|no such host|name resolution|host unreachable/.test(lower)) return 'DNS 解析失败';
  if (/tls|ssl|certificate|handshake|wrong version/.test(lower)) return 'TLS 握手失败';
  if (/reset|econnreset|broken pipe/.test(lower)) return '连接被重置';
  if (/refused|econnrefused/.test(lower)) return '连接被拒绝';
  return text || '测速失败';
}

function compactRuntimeError(stderr, error) {
  const detail = stderr.join('\n')
    .split(/\r?\n/)
    .map((line) => stripAnsi(line).trim())
    .filter((line) => line && !/read http request: EOF/i.test(line))
    .slice(-2)
    .join(' | ');
  return normalizeProbeError(detail || error);
}

function isTransientSpeedtestError(error) {
  const text = normalizeProbeError(error).toLowerCase();
  return /tls|ssl|鎻℃墜|握手|timeout|瓒呮椂|超时|reset|重置|socket disconnected|bad record mac/i.test(text);
}

function buildSpeedtestConfig(nodes, portByNodeId) {
  const targets = (nodes || []).filter((node) => node && !nodeConfigError(node));
  return {
    log: { level: 'error' },
    inbounds: targets.map((node) => ({
      type: 'socks',
      tag: `in-${node.id}`,
      listen: '127.0.0.1',
      listen_port: portByNodeId.get(node.id)
    })),
    outbounds: [
      ...targets.map(buildNodeOutbound).filter(Boolean),
      { type: 'direct', tag: 'direct' }
    ],
    dns: {
      servers: [{ type: 'local', tag: 'dns-local' }],
      final: 'dns-local'
    },
    route: {
      rules: targets.map((node) => ({
        inbound: [`in-${node.id}`],
        outbound: `out-${node.id}`
      })),
      final: 'direct',
      auto_detect_interface: true
    }
  };
}

async function allocateSpeedtestPorts(nodes) {
  const portByNodeId = new Map();
  const used = new Set();
  for (const node of nodes) {
    let port = await getFreePort();
    while (used.has(port)) port = await getFreePort();
    used.add(port);
    portByNodeId.set(node.id, port);
  }
  return portByNodeId;
}

function socks5hConnect(port, target) {
  return new Promise((resolve, reject) => {
    const targetPort = toInt(target.port, target.protocol === 'https:' ? 443 : 80);
    const domain = Buffer.from(target.hostname);
    if (!domain.length || domain.length > 255) {
      reject(new Error('DNS 解析失败'));
      return;
    }

    const socket = net.connect({ host: '127.0.0.1', port });
    let buffer = Buffer.alloc(0);
    let stage = 'method';
    let settled = false;

    const cleanup = () => {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('timeout', onTimeout);
      socket.removeListener('close', onClose);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.on('error', () => {});
      socket.destroy();
      reject(error);
    };
    const done = () => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.on('error', () => {});
      socket.setTimeout(0);
      resolve(socket);
    };
    const sendConnectRequest = () => {
      const request = Buffer.alloc(7 + domain.length);
      request[0] = 0x05;
      request[1] = 0x01;
      request[2] = 0x00;
      request[3] = 0x03;
      request[4] = domain.length;
      domain.copy(request, 5);
      request.writeUInt16BE(targetPort, 5 + domain.length);
      socket.write(request);
    };
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 'method') {
        if (buffer.length < 2) return;
        if (buffer[0] !== 0x05 || buffer[1] !== 0x00) {
          fail(new Error('SOCKS authentication failed'));
          return;
        }
        buffer = buffer.slice(2);
        stage = 'connect';
        sendConnectRequest();
      }
      if (stage === 'connect') {
        if (buffer.length < 5) return;
        if (buffer[1] !== 0x00) {
          fail(new Error(socksReplyMessage(buffer[1])));
          return;
        }
        const atyp = buffer[3];
        let expectedLength = 0;
        if (atyp === 0x01) expectedLength = 10;
        if (atyp === 0x03) expectedLength = 5 + buffer[4] + 2;
        if (atyp === 0x04) expectedLength = 22;
        if (!expectedLength) {
          fail(new Error('SOCKS address type not supported'));
          return;
        }
        if (buffer.length >= expectedLength) done();
      }
    };
    const onError = (error) => fail(error);
    const onTimeout = () => fail(new Error('timeout'));
    const onClose = () => fail(new Error('connection reset'));

    socket.setTimeout(TEST_TIMEOUT_MS);
    socket.once('connect', () => socket.write(Buffer.from([0x05, 0x01, 0x00])));
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('timeout', onTimeout);
    socket.once('close', onClose);
  });
}

function readHttpStatus(stream, requestText, start) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;
    const cleanup = () => {
      stream.removeListener('data', onData);
      stream.removeListener('error', onError);
      stream.removeListener('timeout', onTimeout);
      stream.removeListener('end', onEnd);
    };
    const finish = (error, status) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(status);
    };
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      const match = buffer.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/);
      if (match) finish(null, toInt(match[1], 0));
    };
    const onError = (error) => finish(error);
    const onTimeout = () => finish(new Error('timeout'));
    const onEnd = () => finish(new Error('connection reset'));
    const ignoreLateError = () => {};

    stream.on('error', ignoreLateError);
    stream.setTimeout(TEST_TIMEOUT_MS);
    stream.on('data', onData);
    stream.once('error', onError);
    stream.once('timeout', onTimeout);
    stream.once('end', onEnd);
    start(() => stream.write(requestText));
  });
}

async function probeSocks5hProxy(port, rawUrl) {
  const target = new URL(rawUrl);
  const started = Date.now();
  const socket = await socks5hConnect(port, target);
  const requestPath = `${target.pathname || '/'}${target.search || ''}`;
  const requestText = `GET ${requestPath} HTTP/1.1\r\nHost: ${target.host}\r\nConnection: close\r\n\r\n`;
  try {
    let status = 0;
    if (target.protocol === 'https:') {
      const secure = tls.connect({
        socket,
        servername: target.hostname,
        rejectUnauthorized: false
      });
      try {
        status = await readHttpStatus(secure, requestText, (write) => secure.once('secureConnect', write));
      } finally {
        secure.destroy();
      }
    } else {
      status = await readHttpStatus(socket, requestText, (write) => write());
    }
    if (status < 200 || status >= 400) {
      throw new Error(`HTTP ${status}`);
    }
    return Date.now() - started;
  } finally {
    socket.destroy();
  }
}

async function measureNodeViaPort(node, port, options = {}) {
  const sampleCount = options.sampleCount || SPEEDTEST_SAMPLE_COUNT;
  const intervalMs = options.intervalMs ?? SPEEDTEST_SAMPLE_INTERVAL_MS;
  const testUrl = options.testUrl || state.settings.testUrl;
  const latencies = [];
  const errors = [];

  for (let index = 0; index < sampleCount; index += 1) {
    try {
      latencies.push(await probeSocks5hProxy(port, testUrl));
    } catch (error) {
      errors.push(normalizeProbeError(error));
    }
    if (index < sampleCount - 1) await sleep(intervalMs);
  }

  if (latencies.length) {
    return { id: node.id, ok: true, latencyMs: Math.min(...latencies) };
  }
  return {
    id: node.id,
    ok: false,
    error: [...new Set(errors)].join(' / ') || '测速失败'
  };
}

async function runSpeedtestRuntime(nodes, options = {}) {
  const targets = (nodes || []).filter((node) => node && !nodeConfigError(node));
  if (!targets.length) return [];

  const portByNodeId = options.portByNodeId || await allocateSpeedtestPorts(targets);
  const configPath = path.join(TEMP_DIR, `speedtest-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`);
  const config = buildSpeedtestConfig(targets, portByNodeId);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  const child = spawn(state.settings.singBoxPath, ['run', '-c', configPath], { windowsHide: true });
  const stderr = [];
  child.stdout.on('data', (data) => stderr.push(String(data)));
  child.stderr.on('data', (data) => stderr.push(String(data)));
  child.once('error', (error) => stderr.push(error.message));

  try {
    await Promise.all([...portByNodeId.values()].map((port) => waitForPort(port, '127.0.0.1', 5000)));
    await sleep(options.warmupMs ?? SPEEDTEST_WARMUP_MS);
    return await runLimited(targets, options.concurrency || SPEEDTEST_CONCURRENCY, (node) => measureNodeViaPort(node, portByNodeId.get(node.id), options));
  } catch (error) {
    const message = compactRuntimeError(stderr, error);
    return targets.map((node) => ({ id: node.id, ok: false, error: message }));
  } finally {
    await stopProcess(child, 1500);
    try {
      fs.rmSync(configPath, { force: true });
    } catch {
      // best effort
    }
  }
}

async function recheckTransientSpeedtestFailures(nodes, results, options = {}) {
  const targets = (nodes || []).filter((node) => node && !nodeConfigError(node));
  if (targets.length <= 1) return results;

  const byId = new Map(targets.map((node) => [node.id, node]));
  const retryItems = (results || [])
    .filter((result) => !result.ok && byId.has(result.id) && isTransientSpeedtestError(result.error));
  if (!retryItems.length) return results;

  const retryResults = await runLimited(retryItems, options.recheckConcurrency || SPEEDTEST_RECHECK_CONCURRENCY, async (item) => {
    const [result] = await runSpeedtestRuntime([byId.get(item.id)], {
      ...options,
      concurrency: 1,
      sampleCount: Math.max(3, options.sampleCount || SPEEDTEST_SAMPLE_COUNT),
      warmupMs: Math.max(1500, options.warmupMs || SPEEDTEST_WARMUP_MS)
    });
    return result ? { ...result, rechecked: true } : item;
  });

  const retryById = new Map(retryResults.map((result) => [result.id, result]));
  return results.map((result) => retryById.get(result.id) || result);
}

function applySpeedtestResultsToNodes(nodes, results, now = new Date().toISOString()) {
  for (const result of results) {
    const node = nodes.find((item) => item.id === result.id);
    if (!node) continue;
    node.lastTestAt = now;
    if (result.ok) {
      node.status = 'up';
      node.autoDisabled = false;
      node.latencyMs = result.latencyMs;
      node.error = null;
      node.failCount = 0;
      node.successCount = Math.max(0, toInt(node.successCount, 0)) + 1;
    } else {
      const failCount = Math.max(0, toInt(node.failCount, 0)) + 1;
      const disableNow = failCount >= AUTO_DISABLE_FAIL_THRESHOLD;
      const keepPreviousUp = !disableNow && isTransientSpeedtestError(result.error) && node.status === 'up' && Number.isFinite(Number(node.latencyMs));
      if (!keepPreviousUp) {
        node.status = 'down';
        node.latencyMs = null;
      }
      node.autoDisabled = disableNow;
      node.error = result.error || '测速失败';
      node.failCount = failCount;
      node.successCount = 0;
    }
  }
  return nodes;
}

async function runBackgroundTasks() {
  try {
    const subscriptionsChanged = await runGroupSubscriptionSyncIfDue();
    if (subscriptionsChanged) return;
    await runAutoTestIfDue();
    await runAutoSwitchIfDue();
  } catch (error) {
    appendCoreLog(`后台任务异常：${normalizeString(error?.message) || '未知错误'}`);
  }
}

async function runLimited(items, limit, worker) {
  const results = [];
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = items[index];
      index += 1;
      results.push(await worker(current));
    }
  });
  await Promise.all(workers);
  return results;
}

async function testNodes(nodeIds = []) {
  if (testing) throw new Error('A health check is already running');
  const selectedIds = new Set(nodeIds.map(normalizeString).filter(Boolean));
  const targets = state.nodes.filter((node) => !selectedIds.size || selectedIds.has(node.id));
  if (!targets.length) return [];

  testing = true;
  const before = runtimeSignature();
  try {
    const invalidResults = targets
      .map((node) => ({ node, error: nodeConfigError(node) }))
      .filter((item) => item.error)
      .map((item) => ({ id: item.node.id, ok: false, error: item.error }));
    const speedtestResults = await recheckTransientSpeedtestFailures(targets, await runSpeedtestRuntime(targets));
    const results = [
      ...invalidResults,
      ...speedtestResults
    ];
    const now = new Date().toISOString();
    applySpeedtestResultsToNodes(state.nodes, results, now);
    state.settings.lastTestAt = now;
    applyGroupSelections();
    saveState();
    const after = runtimeSignature();
    if (core.process && before !== after) {
      await restartCore();
    }
    return results;
  } finally {
    testing = false;
  }
}

async function runAutoTestIfDue() {
  if (testing || !state.nodes.length) return;
  const last = state.settings.lastTestAt ? Date.parse(state.settings.lastTestAt) : 0;
  if (Number.isFinite(last) && Date.now() - last < state.settings.testIntervalSec * 1000) return;
  try {
    await testNodes([]);
  } catch (error) {
    appendCoreLog(`自动测速失败：${error.message}`);
  }
}

function normalizeSubscriptionContent(raw) {
  const text = normalizeString(raw).replace(/\uFEFF/g, '');
  if (!text) return '';
  if (text.includes('://') || /^[\[{]/.test(text)) return text;

  const compact = text.replace(/\s+/g, '');
  if (!compact || compact.length < 16 || !/^[A-Za-z0-9+/=_-]+$/.test(compact)) return text;

  try {
    const decoded = decodeBase64(compact).trim();
    if (decoded.includes('://') || /^[\[{]/.test(decoded)) return decoded;
  } catch {
    // ignore
  }

  return text;
}

async function fetchRemoteText(url, timeoutMs = 15000) {
  if (typeof fetch !== 'function') throw new Error('当前环境不支持 fetch');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: 'text/plain, application/json;q=0.9, */*;q=0.8'
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function getGroupById(id) {
  return state.groups.find((group) => group.id === id) || null;
}

function normalizeFirewallSource(value) {
  const text = normalizeString(value);
  if (!text) throw new Error('来源 IP 或网段不能为空');
  const match = text.match(/^(\d{1,3}(?:\.\d{1,3}){3})(?:\/(\d{1,2}))?$/);
  if (!match) throw new Error('仅支持 IPv4 或 IPv4/CIDR');
  const octets = match[1].split('.').map((part) => Number(part));
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) throw new Error('来源 IP 无效');
  if (match[2] !== undefined) {
    const mask = Number(match[2]);
    if (!Number.isInteger(mask) || mask < 0 || mask > 32) throw new Error('网段掩码无效');
  }
  return text;
}

function normalizeFirewallPort(value) {
  const port = toInt(value, 0);
  if (port < 1 || port > 65535) throw new Error('端口无效');
  return port;
}

function runIptables(args) {
  return execFileSync('iptables', ['-w', ...args], { encoding: 'utf8' });
}

function firewallRuleArgs(source, port) {
  return ['-s', source, '-p', 'tcp', '--dport', String(port), '-j', 'ACCEPT'];
}

function getFirewallState() {
  const ports = new Set([state.settings.httpPort, state.settings.socksPort].map((value) => toInt(value, 0)).filter((value) => value > 0));
  try {
    const output = runIptables(['-S', 'INPUT']);
    const rules = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => {
        if (!line.startsWith('-A INPUT')) return false;
        if (!line.includes('-j ACCEPT') || !line.includes('-p tcp')) return false;
        const match = line.match(/--dport\s+(\d+)/);
        return match && ports.has(Number(match[1]));
      });
    return {
      available: true,
      ports: { http: state.settings.httpPort, socks: state.settings.socksPort },
      rules
    };
  } catch (error) {
    return {
      available: false,
      ports: { http: state.settings.httpPort, socks: state.settings.socksPort },
      rules: [],
      error: normalizeString(error.message) || 'iptables 不可用'
    };
  }
}

function openFirewallRule(source, port) {
  const args = firewallRuleArgs(source, port);
  try {
    runIptables(['-C', 'INPUT', ...args]);
  } catch {
    runIptables(['-I', 'INPUT', '1', ...args]);
  }
}

function deleteFirewallRule(source, port) {
  const args = firewallRuleArgs(source, port);
  try {
    runIptables(['-D', 'INPUT', ...args]);
    return true;
  } catch {
    return false;
  }
}

function normalizeSubscriptionUpdateInterval(value) {
  return Math.min(10080, Math.max(1, toInt(value, 60)));
}

function buildSubscriptionConverterUrl(converterUrl, sourceUrl) {
  const base = normalizeString(converterUrl);
  if (!base) return '';
  const endpoint = new URL(base);
  if (!endpoint.pathname || endpoint.pathname === '/') {
    endpoint.pathname = '/sub';
  } else if (endpoint.pathname.endsWith('/')) {
    endpoint.pathname += 'sub';
  }
  endpoint.searchParams.set('target', 'singbox');
  endpoint.searchParams.set('url', sourceUrl);
  return endpoint.toString();
}

function subscriptionFetchCandidates(sourceUrl) {
  const directUrl = normalizeString(sourceUrl);
  const candidates = [];
  const seen = new Set();
  const add = (label, url) => {
    const text = normalizeString(url);
    if (!text || seen.has(text)) return;
    seen.add(text);
    candidates.push({ label, url: text });
  };

  const converterUrl = normalizeString(state.settings.subscriptionConverterUrl);
  if (converterUrl) {
    try {
      add('订阅转换', buildSubscriptionConverterUrl(converterUrl, directUrl));
    } catch (error) {
      appendCoreLog('订阅转换地址无效：' + error.message);
    }
  }
  add('原始订阅', directUrl);
  return candidates;
}

function findGroupSubscription(group, subscriptionId) {
  const id = normalizeString(subscriptionId);
  return (group?.subscriptions || []).find((subscription) => subscription.id === id) || null;
}

function matchesSubscriptionNode(node, group, subscription) {
  if (!node || node.sourceType !== 'subscription' || node.sourceGroupId !== group.id) return false;
  if (node.sourceSubscriptionId === subscription.id) return true;
  if (!node.sourceSubscriptionId && normalizeString(node.sourceUrl) === subscription.url) return true;
  return !node.sourceSubscriptionId && (group.subscriptions || []).length <= 1;
}

function syncGroupSubscriptionSummary(group) {
  const subscriptions = group.subscriptions || [];
  group.subscriptionUrl = subscriptions[0]?.url || '';
  group.subscriptionLastCount = subscriptions.reduce((sum, subscription) => sum + Math.max(0, toInt(subscription.lastCount, 0)), 0);
  const failed = subscriptions.find((subscription) => subscription.lastError);
  group.subscriptionLastError = failed ? failed.name + ': ' + failed.lastError : null;
}

async function importSubscriptionNodes(group, subscription) {
  const candidates = subscriptionFetchCandidates(subscription.url);
  let lastError = null;
  for (const candidate of candidates) {
    try {
      const raw = await fetchRemoteText(candidate.url);
      const decoded = normalizeSubscriptionContent(raw);
      const imported = importNodes(decoded, group.name, {
        sourceType: 'subscription',
        sourceGroupId: group.id,
        sourceSubscriptionId: subscription.id,
        sourceUrl: subscription.url,
        sourceKey: subscription.id
      });
      if (imported.length) return imported;
      lastError = candidate.label + '没有可用节点';
    } catch (error) {
      lastError = candidate.label + '失败：' + error.message;
    }
  }
  throw new Error(lastError || '订阅里没有可用节点');
}

async function refreshGroupSubscription(group, subscription, { force = false } = {}) {
  const targetGroup = getGroupById(group?.id) || group;
  if (!targetGroup) throw new Error('分组未找到');
  const targetSubscription = findGroupSubscription(targetGroup, subscription?.id) || subscription;
  if (!targetSubscription || !normalizeString(targetSubscription.url)) throw new Error('订阅未找到');
  if (targetSubscription.enabled === false && !force) {
    return { changed: false, skipped: true, importedCount: targetSubscription.lastCount || 0 };
  }

  const imported = await importSubscriptionNodes(targetGroup, targetSubscription);
  if (!imported.length) throw new Error('订阅里没有可用节点');

  state.nodes = state.nodes.filter((node) => !matchesSubscriptionNode(node, targetGroup, targetSubscription));
  state.nodes.push(...imported);
  targetGroup.subscriptionLastSyncAt = new Date().toISOString();
  targetSubscription.lastSyncAt = new Date().toISOString();
  targetSubscription.lastError = null;
  targetSubscription.lastCount = imported.length;
  syncGroupSubscriptionSummary(targetGroup);
  syncGroups(state);
  return { changed: true, importedCount: imported.length };
}

async function refreshSubscriptionGroup(group, { force = false } = {}) {
  const targetGroup = getGroupById(group?.id) || group;
  if (!targetGroup) throw new Error('分组未找到');
  const subscriptions = (targetGroup.subscriptions || []).filter((subscription) => subscription.enabled !== false && normalizeString(subscription.url));
  if (!subscriptions.length) throw new Error('该分组还没有订阅链接');

  const intervalMs = normalizeSubscriptionUpdateInterval(targetGroup.subscriptionUpdateIntervalMin) * 60 * 1000;
  if (!force && targetGroup.subscriptionLastSyncAt) {
    const last = Date.parse(targetGroup.subscriptionLastSyncAt);
    if (Number.isFinite(last) && Date.now() - last < intervalMs) {
      return { changed: false, skipped: true, importedCount: targetGroup.subscriptionLastCount || 0, errors: [] };
    }
  }

  let changed = false;
  let importedCount = 0;
  const errors = [];
  for (const subscription of subscriptions) {
    try {
      const result = await refreshGroupSubscription(targetGroup, subscription, { force: true });
      importedCount += result.importedCount || 0;
      changed = changed || Boolean(result.changed);
    } catch (error) {
      subscription.lastError = error.message;
      subscription.lastSyncAt = new Date().toISOString();
      errors.push(subscription.name + ': ' + error.message);
      appendCoreLog('订阅更新失败：' + targetGroup.name + ' / ' + subscription.name + ' - ' + error.message);
    }
  }

  targetGroup.subscriptionLastSyncAt = new Date().toISOString();
  syncGroupSubscriptionSummary(targetGroup);
  if (errors.length && !changed) {
    throw new Error(errors.join('；'));
  }
  return { changed, importedCount: importedCount || targetGroup.subscriptionLastCount || 0, errors };
}

async function runGroupSubscriptionSyncIfDue() {
  if (testing || syncingSubscriptions || !state.groups.length) return false;
  const dueGroups = state.groups.filter((group) => (group.subscriptions || []).some((subscription) => subscription.enabled !== false && subscription.url))
    .filter((group) => {
      const last = group.subscriptionLastSyncAt ? Date.parse(group.subscriptionLastSyncAt) : 0;
      return !Number.isFinite(last) || Date.now() - last >= normalizeSubscriptionUpdateInterval(group.subscriptionUpdateIntervalMin) * 60 * 1000;
    });

  if (!dueGroups.length) return false;

  syncingSubscriptions = true;
  const before = runtimeSignature();
  let changed = false;
  try {
    for (const group of dueGroups) {
      try {
        const result = await refreshSubscriptionGroup(group, { force: true });
        changed = changed || Boolean(result.changed);
      } catch (error) {
        group.subscriptionLastError = error.message;
        group.subscriptionLastSyncAt = new Date().toISOString();
        appendCoreLog('订阅更新失败：' + group.name + ' - ' + error.message);
      }
    }
    saveState();
    const after = runtimeSignature();
    if (changed && core.process && before !== after) {
      await restartCore();
    }
    return changed;
  } finally {
    syncingSubscriptions = false;
  }
}

function importNodes(text, groupName = '', options = {}) {
  const raw = normalizeString(text);
  if (!raw) return [];
  const imported = [];
  const targetGroupName = normalizeGroupName(groupName);
  const sourceType = normalizeString(options.sourceType) || 'manual';
  const sourceGroupId = normalizeString(options.sourceGroupId) || null;
  const sourceSubscriptionId = normalizeString(options.sourceSubscriptionId || options.subscriptionId) || null;
  const sourceUrl = normalizeString(options.sourceUrl) || null;
  const sourceKey = normalizeString(options.sourceKey) || sourceSubscriptionId;

  try {
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.outbounds) ? parsed.outbounds : [parsed]);
    for (const item of items) {
      const node = normalizeNode({
        ...item,
        id: createId('node_'),
        name: item.name || item.tag || item.server,
        port: item.port || item.server_port,
        group: targetGroupName,
        sourceType,
        sourceGroupId,
        sourceSubscriptionId,
        sourceUrl,
        sourceKey
      });
      if (node) imported.push(node);
    }
    return imported;
  } catch {
    // fall through to line parser
  }

  for (const line of raw.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
    const node = parseProxyLink(line, targetGroupName);
    if (node) {
      imported.push(normalizeNode({ ...node, sourceType, sourceGroupId, sourceSubscriptionId, sourceUrl, sourceKey }));
    }
  }
  return imported;
}

function decodeBase64(value) {
  const normalized = String(value || '').trim().replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64').toString('utf8');
}

function parseProxyLink(line, groupName = '') {
  try {
    if (line.startsWith('vmess://')) {
      const data = JSON.parse(decodeBase64(line.slice('vmess://'.length)));
      return normalizeNode({
        id: createId('node_'),
        type: 'vmess',
        name: data.ps || data.add,
        server: data.add,
        port: data.port,
        uuid: data.id,
        alterId: data.aid,
        security: normalizeString(data.scy || data.security) || 'auto',
        tls: normalizeString(data.tls).toLowerCase() === 'tls',
        sni: data.sni || data.host || data.add,
        alpn: data.alpn,
        fingerprint: data.fp || data.fingerprint,
        transport: data.net,
        wsPath: data.path,
        wsHost: data.host,
        packetEncoding: data.packet_encoding || data.packetEncoding,
        maxEarlyData: data.ed || data.max_early_data,
        earlyDataHeaderName: data.early_data_header_name,
        serviceName: data.serviceName || data.service_name,
        group: groupName
      });
    }

    if (line.startsWith('ss://')) {
      return parseShadowsocksLink(line, groupName);
    }

    const url = new URL(line);
    const scheme = url.protocol.replace(':', '').toLowerCase();
    const name = decodeURIComponent(url.hash.replace(/^#/, '')) || url.hostname;
    const params = url.searchParams;
    const common = {
      id: createId('node_'),
      name,
      server: url.hostname,
      port: url.port || (scheme === 'https' ? 443 : 0),
      group: groupName,
      security: normalizeString(params.get('security') || params.get('tls')),
      sni: normalizeString(params.get('sni') || params.get('peer') || params.get('host')),
      alpn: normalizeString(params.get('alpn')),
      transport: normalizeString(params.get('type') || params.get('transport')),
      wsPath: normalizeString(params.get('path')),
      wsHost: normalizeString(params.get('host')),
      maxEarlyData: normalizeString(params.get('ed') || params.get('max_early_data')),
      earlyDataHeaderName: normalizeString(params.get('early_data_header_name') || params.get('earlyDataHeaderName') || params.get('eh')),
      serviceName: normalizeString(params.get('serviceName') || params.get('service_name')),
      pbk: normalizeString(params.get('pbk')),
      sid: normalizeString(params.get('sid')),
      spx: normalizeString(params.get('spx') || params.get('spiderX') || params.get('spider_x')),
      flow: normalizeString(params.get('flow')),
      fingerprint: normalizeString(params.get('fp') || params.get('fingerprint') || params.get('utls')),
      packetEncoding: normalizeString(params.get('packet_encoding') || params.get('packetEncoding')),
      obfs: normalizeString(params.get('obfs')),
      obfsPassword: normalizeString(params.get('obfs-password') || params.get('obfs_password') || params.get('obfsPassword')),
      upMbps: normalizeString(params.get('up_mbps') || params.get('upmbps') || params.get('up')),
      downMbps: normalizeString(params.get('down_mbps') || params.get('downmbps') || params.get('down')),
      heartbeat: normalizeString(params.get('heartbeat')),
      congestionControl: normalizeString(params.get('congestion_control') || params.get('congestion') || params.get('cc')),
      udpRelayMode: normalizeString(params.get('udp_relay_mode') || params.get('udp-relay-mode')),
      insecure: ['1', 'true', 'yes'].includes(normalizeString(params.get('allowInsecure') || params.get('insecure') || params.get('skip-cert-verify')).toLowerCase())
    };

    if (scheme === 'socks' || scheme === 'socks5') {
      return normalizeNode({
        ...common,
        type: 'socks',
        username: decodeURIComponent(url.username || ''),
        password: decodeURIComponent(url.password || '')
      });
    }
    if (scheme === 'http' || scheme === 'https') {
      return normalizeNode({
        ...common,
        type: 'http',
        username: decodeURIComponent(url.username || ''),
        password: decodeURIComponent(url.password || '')
      });
    }
    if (scheme === 'vless') {
      return normalizeNode({
        ...common,
        type: 'vless',
        uuid: decodeURIComponent(url.username || ''),
        security: common.security || (common.pbk ? 'reality' : '')
      });
    }
    if (scheme === 'trojan') {
      return normalizeNode({
        ...common,
        type: 'trojan',
        password: decodeURIComponent(url.username || ''),
        security: common.security || 'tls'
      });
    }
    if (scheme === 'hysteria2' || scheme === 'hy2') {
      return normalizeNode({
        ...common,
        type: 'hysteria2',
        password: decodeURIComponent(url.username || ''),
        alpn: common.alpn || 'h3',
        security: 'tls'
      });
    }
    if (scheme === 'tuic') {
      return normalizeNode({
        ...common,
        type: 'tuic',
        uuid: decodeURIComponent(url.username || ''),
        password: decodeURIComponent(url.password || ''),
        alpn: common.alpn || 'h3',
        security: 'tls'
      });
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeShadowsocksPlugin(value) {
  const plugin = normalizeString(value).toLowerCase();
  if (!plugin) return '';
  if (plugin === 'v2ray-plugin' || plugin === 'obfs-local') return plugin;
  return '';
}

function parseShadowsocksCredential(value) {
  const text = normalizeString(value);
  if (!text) return { method: '', password: '' };
  const splitCredential = (credential) => {
    const index = credential.indexOf(':');
    if (index < 0) return null;
    return {
      method: credential.slice(0, index),
      password: credential.slice(index + 1)
    };
  };

  const direct = splitCredential(text);
  if (direct) return direct;

  try {
    const decoded = decodeBase64(text).trim();
    const parsed = splitCredential(decoded);
    if (parsed) return parsed;
  } catch {
    // Not a base64 encoded SIP002 credential.
  }

  return { method: text, password: '' };
}

function parseShadowsocksPlugin(params) {
  const rawPlugin = normalizeString(params.get('plugin') || params.get('plugin_name') || params.get('pluginName'));
  const rawOpts = normalizeString(params.get('plugin_opts') || params.get('plugin-opts') || params.get('pluginOpts'));
  if (!rawPlugin && !rawOpts) return { plugin: '', pluginOpts: '' };

  const parts = rawPlugin.split(';').map((part) => part.trim()).filter(Boolean);
  const plugin = normalizeShadowsocksPlugin(parts.shift() || rawPlugin);
  const pluginOpts = [...parts, rawOpts].filter(Boolean).join(';');
  return { plugin, pluginOpts };
}

function parseShadowsocksLink(line, groupName = '') {
  const raw = line.slice('ss://'.length);
  const [withoutHash, hash = ''] = raw.split('#');
  const name = hash ? decodeURIComponent(hash) : '';
  let urlText = withoutHash;
  if (!withoutHash.includes('@')) {
    urlText = decodeBase64(withoutHash);
  }
  const url = new URL(`ss://${urlText}`);
  let method = decodeURIComponent(url.username || '');
  let password = decodeURIComponent(url.password || '');
  if (!password) {
    const credential = parseShadowsocksCredential(method);
    method = credential.method;
    password = credential.password;
  }
  const { plugin, pluginOpts } = parseShadowsocksPlugin(url.searchParams);
  return normalizeNode({
    id: createId('node_'),
    type: 'shadowsocks',
    name: name || url.hostname,
    server: url.hostname,
    port: url.port,
    method,
    password,
    plugin,
    pluginOpts,
    group: groupName
  });
}

function updateNode(id, patch) {
  const index = state.nodes.findIndex((node) => node.id === id);
  if (index < 0) throw new Error('节点未找到');
  const next = normalizeNode({ ...state.nodes[index], ...patch, id });
  if (!next) throw new Error('节点无效');
  state.nodes[index] = next;
  syncGroups(state);
  saveState();
  return next;
}

function updateNodes(ids, patch) {
  const selectedIds = new Set((ids || []).map(normalizeString).filter(Boolean));
  if (!selectedIds.size) throw new Error('请先选择节点');
  const updated = [];
  for (let index = 0; index < state.nodes.length; index += 1) {
    const node = state.nodes[index];
    if (!selectedIds.has(node.id)) continue;
    const next = normalizeNode({ ...node, ...patch, id: node.id });
    if (!next) throw new Error('节点无效');
    state.nodes[index] = next;
    updated.push(next);
  }
  if (!updated.length) throw new Error('节点未找到');
  syncGroups(state);
  saveState();
  return updated;
}

function deleteNode(id) {
  state.nodes = state.nodes.filter((node) => node.id !== id);
  syncGroups(state);
  saveState();
}

async function handleApi(req, res, pathname) {
  if (pathname === '/api/session' && req.method === 'GET') {
    sendJson(res, 200, { authenticated: isAuthenticated(req), setupRequired: !state.settings.passwordHash });
    return;
  }

  if (pathname === '/api/setup' && req.method === 'POST') {
    if (state.settings.passwordHash) {
      sendJson(res, 400, { ok: false, error: 'Web 密码已经设置' });
      return;
    }
    const body = await readJsonBody(req);
    if (!body.password || String(body.password).length < 6) throw new Error('密码至少需要 6 位');
    state.settings.passwordHash = hashPassword(body.password);
    saveState();
    createSession(res);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === '/api/login' && req.method === 'POST') {
    const body = await readJsonBody(req);
    if (!state.settings.passwordHash || !verifyPassword(body.password || '', state.settings.passwordHash)) {
      sendJson(res, 401, { ok: false, error: '密码错误' });
      return;
    }
    createSession(res);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (!isAuthenticated(req)) {
    sendJson(res, 401, { ok: false, error: '未授权' });
    return;
  }

  if (pathname === '/api/logout' && req.method === 'POST') {
    clearSession(req, res);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === '/api/state' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, ...publicState() });
    return;
  }

  if (pathname === '/api/settings' && req.method === 'PUT') {
    const body = await readJsonBody(req);
    state.settings = {
      ...state.settings,
      proxyListenHost: normalizeString(body.proxyListenHost) || state.settings.proxyListenHost,
      httpPort: body.httpPort == null ? state.settings.httpPort : toInt(body.httpPort, state.settings.httpPort),
      socksPort: body.socksPort == null ? state.settings.socksPort : toInt(body.socksPort, state.settings.socksPort),
      singBoxPath: normalizeString(body.singBoxPath) || state.settings.singBoxPath,
      testUrl: normalizeString(body.testUrl) || state.settings.testUrl,
      testIntervalSec: body.testIntervalSec == null ? state.settings.testIntervalSec : toInt(body.testIntervalSec, state.settings.testIntervalSec),
      switchPolicy: ['best', 'random'].includes(body.switchPolicy) ? body.switchPolicy : state.settings.switchPolicy,
      switchMode: ['manual', 'auto'].includes(body.switchMode) ? body.switchMode : state.settings.switchMode,
      manualNodeId: body.manualNodeId === undefined ? state.settings.manualNodeId : (normalizeString(body.manualNodeId) || null),
      autoSwitchIntervalMin: body.autoSwitchIntervalMin == null ? state.settings.autoSwitchIntervalMin : toInt(body.autoSwitchIntervalMin, state.settings.autoSwitchIntervalMin),
      activeGroupId: normalizeString(body.activeGroupId) || state.settings.activeGroupId,
      subscriptionConverterUrl: body.subscriptionConverterUrl === undefined
        ? state.settings.subscriptionConverterUrl
        : normalizeString(body.subscriptionConverterUrl)
    };
    if (body.switchMode === 'auto' || body.activeGroupId !== undefined || body.autoSwitchIntervalMin != null) {
      state.settings.lastSwitchAt = new Date().toISOString();
    }
    if (body.password) {
      if (String(body.password).length < 6) throw new Error('密码至少需要 6 位');
      state.settings.passwordHash = hashPassword(body.password);
    }
    saveState();
    if (core.process) await restartCore();
    sendJson(res, 200, { ok: true, ...publicState() });
    return;
  }

  if (pathname === '/api/nodes/import' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const imported = importNodes(body.text || '', normalizeGroupName(body.group));
    state.nodes.push(...imported);
    syncGroups(state);
    saveState();
    sendJson(res, 200, { ok: true, importedCount: imported.length, ...publicState() });
    return;
  }

  if (pathname === '/api/nodes' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const node = normalizeNode({ ...body, id: createId('node_') });
    if (!node) throw new Error('节点无效');
    state.nodes.push(node);
    syncGroups(state);
    saveState();
    sendJson(res, 200, { ok: true, node, ...publicState() });
    return;
  }

  if (pathname === '/api/nodes/batch' && req.method === 'PUT') {
    const body = await readJsonBody(req);
    const nodes = updateNodes(Array.isArray(body.ids) ? body.ids : [], body.patch || {});
    if (core.process) await restartCore();
    sendJson(res, 200, { ok: true, nodes, ...publicState() });
    return;
  }

  const nodeMatch = pathname.match(/^\/api\/nodes\/([^/]+)$/);
  if (nodeMatch && req.method === 'PUT') {
    const node = updateNode(nodeMatch[1], await readJsonBody(req));
    if (core.process) await restartCore();
    sendJson(res, 200, { ok: true, node, ...publicState() });
    return;
  }
  if (nodeMatch && req.method === 'DELETE') {
    deleteNode(nodeMatch[1]);
    if (core.process) await restartCore();
    sendJson(res, 200, { ok: true, ...publicState() });
    return;
  }

  if (pathname === '/api/groups' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const name = normalizeString(body.name);
    if (!name) throw new Error('Group name is required');
    state.groups.push({ id: createId('group_'), name, nodeIds: [], selectedNodeId: null });
    saveState();
    sendJson(res, 200, { ok: true, ...publicState() });
    return;
  }

  const groupMatch = pathname.match(/^\/api\/groups\/([^/]+)$/);
  if (groupMatch && req.method === 'PUT') {
    const body = await readJsonBody(req);
    const group = state.groups.find((item) => item.id === groupMatch[1]);
    if (!group) throw new Error('分组未找到');
    if (body.name) group.name = normalizeString(body.name);
    if (Array.isArray(body.nodeIds)) group.nodeIds = [...new Set(body.nodeIds.map(normalizeString).filter(Boolean))];
    if (body.selectedNodeId !== undefined) group.selectedNodeId = normalizeString(body.selectedNodeId) || null;
    if (body.active) state.settings.activeGroupId = group.id;
    applyGroupSelections();
    saveState();
    if (core.process) await restartCore();
    sendJson(res, 200, { ok: true, ...publicState() });
    return;
  }
  if (groupMatch && req.method === 'DELETE') {
    const group = state.groups.find((item) => item.id === groupMatch[1]);
    if (group) {
      const groupNodeIds = new Set(group.nodeIds || []);
      state.nodes = state.nodes.filter((node) => node.group !== group.name && !groupNodeIds.has(node.id));
      state.groups = state.groups.filter((item) => item.id !== group.id);
      syncGroups(state);
      saveState();
      if (core.process) await restartCore();
    }
    sendJson(res, 200, { ok: true, ...publicState() });
    return;
  }

  if (pathname === '/api/groups/subscription' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const groupId = normalizeString(body.groupId || body.group || body.id);
    const groupName = normalizeString(body.groupName || body.group || body.name);
    const subscriptionId = normalizeString(body.subscriptionId);
    const subscriptionName = normalizeString(body.subscriptionName || body.subscriptionTitle || body.title);
    const subscriptionUrl = normalizeString(body.subscriptionUrl || body.url);
    let group = groupId ? state.groups.find((item) => item.id === groupId) : null;
    if (!group && groupName) {
      group = state.groups.find((item) => item.name === groupName);
    }
    if (!group) {
      if (!groupName) throw new Error('分组名称不能为空');
      if (!subscriptionUrl) throw new Error('订阅链接不能为空');
      group = {
        id: createId('group_'),
        name: groupName,
        nodeIds: [],
        selectedNodeId: null,
        subscriptions: []
      };
      state.groups.push(group);
    }

    if (!group.subscriptions) group.subscriptions = [];
    group.subscriptionUpdateIntervalMin = normalizeSubscriptionUpdateInterval(body.subscriptionUpdateIntervalMin || body.intervalMin || group.subscriptionUpdateIntervalMin || 60);

    const existingSubscription = subscriptionId
      ? findGroupSubscription(group, subscriptionId)
      : (group.subscriptions || []).find((item) => item.url === subscriptionUrl) || null;
    if (subscriptionId && !existingSubscription) throw new Error('订阅未找到');
    if (!subscriptionUrl && !existingSubscription) throw new Error('订阅链接不能为空');

    const nextSubscription = normalizeSubscription({
      ...(existingSubscription || {}),
      id: existingSubscription?.id || createId('sub_'),
      name: subscriptionName || existingSubscription?.name,
      url: subscriptionUrl || existingSubscription?.url,
      enabled: existingSubscription?.enabled !== false,
      lastSyncAt: existingSubscription?.lastSyncAt,
      lastError: existingSubscription?.lastError,
      lastCount: existingSubscription?.lastCount
    });
    if (!nextSubscription) throw new Error('订阅链接不能为空');

    if (existingSubscription) {
      existingSubscription.name = nextSubscription.name;
      existingSubscription.url = nextSubscription.url;
      existingSubscription.enabled = nextSubscription.enabled;
    } else {
      group.subscriptions.push(nextSubscription);
    }

    let syncError = null;
    let syncedCount = 0;
    const before = runtimeSignature();
    try {
      const result = await refreshGroupSubscription(group, nextSubscription, { force: true });
      syncedCount = result.importedCount || 0;
    } catch (error) {
      syncError = error.message;
      nextSubscription.lastError = syncError;
      nextSubscription.lastSyncAt = new Date().toISOString();
      group.subscriptionLastSyncAt = new Date().toISOString();
      syncGroupSubscriptionSummary(group);
    }

    applyGroupSelections();
    saveState();
    if (core.process && !syncError && before !== runtimeSignature()) await restartCore();
    sendJson(res, 200, {
      ok: true,
      groupId: group.id,
      subscriptionId: nextSubscription.id,
      syncedCount,
      syncError,
      ...publicState()
    });
    return;
  }

  const groupSubscriptionSyncMatch = pathname.match(/^\/api\/groups\/([^/]+)\/subscription-sync$/);
  if (groupSubscriptionSyncMatch && req.method === 'POST') {
    const group = state.groups.find((item) => item.id === groupSubscriptionSyncMatch[1]);
    if (!group) throw new Error('分组未找到');
    if (!(group.subscriptions || []).length) throw new Error('该分组还没有订阅链接');

    const before = runtimeSignature();
    const result = await refreshSubscriptionGroup(group, { force: true });
    applyGroupSelections();
    saveState();
    if (core.process && before !== runtimeSignature()) await restartCore();
    sendJson(res, 200, { ok: true, syncedCount: result.importedCount || 0, syncError: result.errors?.join('；') || null, ...publicState() });
    return;
  }

  const groupSubscriptionItemSyncMatch = pathname.match(/^\/api\/groups\/([^/]+)\/subscriptions\/([^/]+)\/sync$/);
  if (groupSubscriptionItemSyncMatch && req.method === 'POST') {
    const group = state.groups.find((item) => item.id === groupSubscriptionItemSyncMatch[1]);
    if (!group) throw new Error('分组未找到');
    const subscription = findGroupSubscription(group, groupSubscriptionItemSyncMatch[2]);
    if (!subscription) throw new Error('订阅未找到');

    const before = runtimeSignature();
    const result = await refreshGroupSubscription(group, subscription, { force: true });
    applyGroupSelections();
    saveState();
    if (core.process && before !== runtimeSignature()) await restartCore();
    sendJson(res, 200, { ok: true, syncedCount: result.importedCount || 0, ...publicState() });
    return;
  }

  const groupSubscriptionItemMatch = pathname.match(/^\/api\/groups\/([^/]+)\/subscriptions\/([^/]+)$/);
  if (groupSubscriptionItemMatch && req.method === 'DELETE') {
    const group = state.groups.find((item) => item.id === groupSubscriptionItemMatch[1]);
    if (!group) throw new Error('分组未找到');
    const subscription = findGroupSubscription(group, groupSubscriptionItemMatch[2]);
    if (!subscription) throw new Error('订阅未找到');

    const before = runtimeSignature();
    state.nodes = state.nodes.filter((node) => !matchesSubscriptionNode(node, group, subscription));
    group.subscriptions = (group.subscriptions || []).filter((item) => item.id !== subscription.id);
    syncGroupSubscriptionSummary(group);
    applyGroupSelections();
    saveState();
    if (core.process && before !== runtimeSignature()) await restartCore();
    sendJson(res, 200, { ok: true, ...publicState() });
    return;
  }

  if (pathname === '/api/firewall' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, firewall: getFirewallState() });
    return;
  }

  if (pathname === '/api/firewall' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const source = normalizeFirewallSource(body.source);
    const port = normalizeFirewallPort(body.port);
    const action = normalizeString(body.action) || 'open';
    if (action === 'delete') {
      deleteFirewallRule(source, port);
    } else {
      openFirewallRule(source, port);
    }
    sendJson(res, 200, { ok: true, firewall: getFirewallState() });
    return;
  }

  if (pathname === '/api/test' && req.method === 'POST') {
    const body = await readJsonBody(req);
    let ids = Array.isArray(body.ids) ? body.ids : [];
    if (body.groupId) {
      const group = state.groups.find((item) => item.id === body.groupId);
      ids = group?.nodeIds || [];
    }
    const results = await testNodes(ids);
    sendJson(res, 200, { ok: true, results, ...publicState() });
    return;
  }

  if (pathname === '/api/core/start' && req.method === 'POST') {
    await startCore();
    sendJson(res, 200, { ok: true, ...publicState() });
    return;
  }
  if (pathname === '/api/core/stop' && req.method === 'POST') {
    await stopCore();
    sendJson(res, 200, { ok: true, ...publicState() });
    return;
  }
  if (pathname === '/api/core/restart' && req.method === 'POST') {
    await restartCore();
    sendJson(res, 200, { ok: true, ...publicState() });
    return;
  }
  if (pathname === '/api/core/config' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, config: buildRuntimeConfig() });
    return;
  }

  sendJson(res, 404, { ok: false, error: '未找到' });
}

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (filePath.endsWith('.png')) return 'image/png';
  return 'application/octet-stream';
}

function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, relative);
  if (!filePath.startsWith(path.resolve(PUBLIC_DIR))) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  const targetPath = fs.existsSync(filePath) && fs.statSync(filePath).isFile()
    ? filePath
    : path.join(PUBLIC_DIR, 'index.html');
  res.writeHead(200, { 'content-type': contentType(targetPath) });
  fs.createReadStream(targetPath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url.pathname);
      return;
    }
    serveStatic(req, res, url.pathname);
  } catch (error) {
    sendJson(res, error.status || 500, { ok: false, error: error.message || '内部错误' });
  }
});

if (require.main === module) {
setInterval(() => {
  void runBackgroundTasks();
}, TEST_TICK_MS).unref?.();

process.on('unhandledRejection', (reason) => {
  appendCoreLog(`未处理的异步错误：${normalizeString(reason?.message || reason) || '未知错误'}`);
});

process.on('uncaughtException', (error) => {
  appendCoreLog(`未捕获异常：${normalizeString(error?.message) || '未知错误'}`);
});

process.once('SIGINT', async () => {
  await stopCore();
  process.exit(0);
});
process.once('SIGTERM', async () => {
  await stopCore();
  process.exit(0);
});

server.listen(state.settings.webPort, state.settings.webHost, () => {
  const shownHost = state.settings.webHost === '0.0.0.0' ? '127.0.0.1' : state.settings.webHost;
  console.log(`Siftlane 正在监听：http://${shownHost}:${state.settings.webPort}`);
  console.log(`数据目录：${DATA_DIR}`);
});

}

module.exports = {
  normalizeNode,
  parseProxyLink,
  buildNodeOutbound,
  normalizeWsEarlyData,
  buildSpeedtestConfig,
  applySpeedtestResultsToNodes,
  decideBestSwitch,
  runBackgroundTasks
};
