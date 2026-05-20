#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
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
const MAX_LOG_LINES = 200;

const sessions = new Map();
const core = {
  process: null,
  status: 'stopped',
  startedAt: null,
  lastError: null,
  logs: []
};

let testing = false;
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
      testUrl: 'http://www.gstatic.com/generate_204',
      testIntervalSec: 300,
      switchPolicy: 'best',
      switchMode: 'manual',
      manualNodeId: null,
      autoSwitchIntervalMin: 10,
      activeGroupId: null,
      lastSwitchAt: null,
      lastTestAt: null,
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
  next.settings.testUrl = normalizeString(next.settings.testUrl) || 'http://www.gstatic.com/generate_204';
  next.settings.testIntervalSec = Math.min(86400, Math.max(30, toInt(next.settings.testIntervalSec, 300)));
  next.settings.switchPolicy = ['best', 'random'].includes(next.settings.switchPolicy) ? next.settings.switchPolicy : 'best';
  next.settings.switchMode = ['manual', 'auto'].includes(next.settings.switchMode) ? next.settings.switchMode : 'manual';
  next.settings.manualNodeId = normalizeString(next.settings.manualNodeId) || null;
  next.settings.autoSwitchIntervalMin = Math.min(1440, Math.max(1, toInt(next.settings.autoSwitchIntervalMin, 10)));
  next.settings.passwordHash = normalizeString(next.settings.passwordHash) || null;
  next.settings.lastSwitchAt = normalizeIso(next.settings.lastSwitchAt);
  next.settings.lastTestAt = normalizeIso(next.settings.lastTestAt);

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

function normalizeNode(node) {
  if (!node || typeof node !== 'object') return null;
  const id = normalizeString(node.id) || createId('node_');
  const type = normalizeString(node.type).toLowerCase();
  const server = normalizeString(node.server);
  const port = toInt(node.port || node.server_port, 0);
  if (!id || !type || !server || !port) return null;

  return {
    id,
    name: normalizeString(node.name) || server,
    type,
    server,
    port,
    group: normalizeString(node.group),
    enabled: node.enabled !== false,
    autoDisabled: Boolean(node.autoDisabled),
    status: ['up', 'down', 'unknown'].includes(node.status) ? node.status : 'unknown',
    latencyMs: Number.isFinite(Number(node.latencyMs)) ? Number(node.latencyMs) : null,
    lastTestAt: normalizeIso(node.lastTestAt),
    error: normalizeString(node.error) || null,
    username: normalizeString(node.username),
    password: normalizeString(node.password),
    method: normalizeString(node.method),
    uuid: normalizeString(node.uuid),
    alterId: toInt(node.alterId, 0),
    security: normalizeString(node.security).toLowerCase(),
    sni: normalizeString(node.sni),
    insecure: Boolean(node.insecure),
    transport: normalizeString(node.transport || node.network).toLowerCase(),
    wsPath: normalizeString(node.wsPath || node.path),
    wsHost: normalizeString(node.wsHost || node.host),
    serviceName: normalizeString(node.serviceName || node.service_name),
    pbk: normalizeString(node.pbk),
    sid: normalizeString(node.sid),
    flow: normalizeString(node.flow),
    fingerprint: normalizeString(node.fingerprint || node.fp)
  };
}

function normalizeGroup(group) {
  if (!group || typeof group !== 'object') return null;
  const id = normalizeString(group.id) || createId('group_');
  const name = normalizeString(group.name);
  if (!id || !name) return null;
  return {
    id,
    name,
    nodeIds: Array.isArray(group.nodeIds) ? [...new Set(group.nodeIds.map(normalizeString).filter(Boolean))] : [],
    selectedNodeId: normalizeString(group.selectedNodeId) || null
  };
}

function syncGroups(targetState = state) {
  const existingByName = new Map((targetState.groups || []).map((group) => [group.name, group]));
  const nodeIds = new Set(targetState.nodes.map((node) => node.id));
  const groups = [];
  const seenNames = new Set();

  for (const node of targetState.nodes) {
    const groupName = normalizeString(node.group);
    if (!groupName || seenNames.has(groupName)) continue;
    seenNames.add(groupName);
    const existing = existingByName.get(groupName);
    const ids = targetState.nodes.filter((item) => item.group === groupName).map((item) => item.id);
    groups.push({
      id: existing?.id || createId('group_'),
      name: groupName,
      nodeIds: ids,
      selectedNodeId: ids.includes(existing?.selectedNodeId) ? existing.selectedNodeId : (ids[0] || null)
    });
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

function getGroupNodes(group) {
  const ids = new Set(group?.nodeIds || []);
  return state.nodes.filter((node) => ids.has(node.id));
}

function chooseGroupNode(group) {
  const usable = getGroupNodes(group).filter(nodeUsable);
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
  return state.nodes.filter(nodeUsable);
}

function getActiveGroup() {
  return state.groups.find((group) => group.id === state.settings.activeGroupId) || state.groups[0] || null;
}

function getManualNode() {
  const selected = state.nodes.find((node) => node.id === state.settings.manualNodeId);
  return nodeUsable(selected) ? selected : (getUsableNodes()[0] || null);
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
  if (!activeGroup || !getGroupNodes(activeGroup).some(nodeUsable)) return null;
  const intervalMs = state.settings.autoSwitchIntervalMin * 60 * 1000;
  const last = state.settings.lastSwitchAt ? Date.parse(state.settings.lastSwitchAt) : Date.now();
  if (!Number.isFinite(last)) return null;
  return new Date(last + intervalMs).toISOString();
}

function rotateActiveGroupSelection() {
  const group = getActiveGroup();
  if (!group) return null;
  const usable = getGroupNodes(group).filter(nodeUsable);
  if (!usable.length) {
    group.selectedNodeId = null;
    return null;
  }
  const currentIndex = usable.findIndex((node) => node.id === group.selectedNodeId);
  const next = usable[(currentIndex + 1 + usable.length) % usable.length] || usable[0];
  group.selectedNodeId = next.id;
  return next;
}

async function runAutoSwitchIfDue() {
  if (testing || !core.process || state.settings.switchMode !== 'auto') return;
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
      usableIds: getGroupNodes(group).filter(nodeUsable).map((node) => node.id)
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
    testing
  };
}

function appendCoreLog(line) {
  const text = stripAnsi(line).trim();
  if (!text || /read http request: EOF/i.test(text)) return;
  core.logs.push({ at: new Date().toISOString(), line: text });
  if (core.logs.length > MAX_LOG_LINES) {
    core.logs.splice(0, core.logs.length - MAX_LOG_LINES);
  }
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
  } else if (node.type === 'vmess') {
    outbound.uuid = node.uuid;
    outbound.security = node.security && node.security !== 'tls' ? node.security : 'auto';
    outbound.alter_id = node.alterId || 0;
    outbound.packet_encoding = 'packetaddr';
  } else if (node.type === 'vless') {
    outbound.uuid = node.uuid;
    outbound.packet_encoding = 'xudp';
    if (node.flow) outbound.flow = node.flow;
  } else if (node.type === 'trojan') {
    outbound.password = node.password;
  } else if (node.type === 'hysteria2') {
    outbound.password = node.password;
  } else if (node.type === 'tuic') {
    outbound.uuid = node.uuid;
    outbound.password = node.password;
    outbound.congestion_control = 'bbr';
  }

  if (node.security === 'tls' || node.security === 'reality' || node.sni || ['trojan', 'hysteria2', 'tuic'].includes(node.type)) {
    outbound.tls = {
      enabled: true,
      server_name: node.sni || node.server,
      insecure: Boolean(node.insecure)
    };
    if (node.security === 'reality' || node.pbk) {
      outbound.tls.reality = {
        enabled: true,
        public_key: node.pbk,
        short_id: node.sid
      };
      outbound.tls.utls = {
        enabled: true,
        fingerprint: node.fingerprint || 'chrome'
      };
    } else if (node.fingerprint) {
      outbound.tls.utls = {
        enabled: true,
        fingerprint: node.fingerprint
      };
    }
  }

  if (node.transport === 'ws') {
    outbound.transport = {
      type: 'ws',
      path: node.wsPath || '/',
      headers: {}
    };
    if (node.wsHost) outbound.transport.headers.Host = node.wsHost;
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
  const usableNodes = state.nodes.filter(nodeUsable);
  const outbounds = usableNodes.map(buildNodeOutbound);
  const groupOutbounds = state.groups.map((group) => {
    const usableIds = getGroupNodes(group).filter(nodeUsable).map((node) => node.id);
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
  const activeOutbound = activeNode ? `out-${activeNode.id}` : 'direct';

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
  await stopCore();
  return startCore();
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

async function probeProxy(port, rawUrl) {
  const target = new URL(rawUrl);
  const started = Date.now();
  const status = target.protocol === 'https:'
    ? await probeHttpsProxy(port, target)
    : await probeHttpProxy(port, target);
  if (status < 200 || status >= 500) {
    throw new Error(`HTTP ${status}`);
  }
  return Date.now() - started;
}

function probeHttpProxy(port, target) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'GET',
      path: target.href,
      timeout: TEST_TIMEOUT_MS,
      headers: {
        Host: target.host,
        Connection: 'close'
      }
    }, (res) => {
      res.resume();
      resolve(res.statusCode || 0);
    });
    req.once('timeout', () => req.destroy(new Error('请求超时')));
    req.once('error', reject);
    req.end();
  });
}

function probeHttpsProxy(port, target) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'CONNECT',
      path: `${target.hostname}:${target.port || 443}`,
      timeout: TEST_TIMEOUT_MS
    });
    req.once('connect', (res, socket) => {
      if ((res.statusCode || 0) !== 200) {
        socket.destroy();
        reject(new Error(`CONNECT ${res.statusCode || 0}`));
        return;
      }
      const secure = tls.connect({
        socket,
        servername: target.hostname,
        rejectUnauthorized: false
      }, () => {
        secure.write(`GET ${target.pathname || '/'}${target.search || ''} HTTP/1.1\r\nHost: ${target.host}\r\nConnection: close\r\n\r\n`);
      });
      let buffer = '';
      secure.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const match = buffer.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/);
        if (match) {
          secure.destroy();
          resolve(toInt(match[1], 0));
        }
      });
      secure.once('error', reject);
      secure.setTimeout(TEST_TIMEOUT_MS, () => secure.destroy(new Error('timeout')));
    });
    req.once('timeout', () => req.destroy(new Error('请求超时')));
    req.once('error', reject);
    req.end();
  });
}

async function measureNode(node) {
  const port = await getFreePort();
  const configPath = path.join(TEMP_DIR, `test-${node.id}-${Date.now()}.json`);
  const config = {
    log: { level: 'error' },
    inbounds: [{
      type: 'http',
      tag: 'test-in',
      listen: '127.0.0.1',
      listen_port: port
    }],
    outbounds: [
      buildNodeOutbound(node),
      { type: 'direct', tag: 'direct' }
    ],
    dns: {
      servers: [{ type: 'local', tag: 'dns-local' }],
      final: 'dns-local'
    },
    route: {
      rules: [{ inbound: ['test-in'], outbound: `out-${node.id}` }],
      final: 'direct',
      auto_detect_interface: true
    }
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  const child = spawn(state.settings.singBoxPath, ['run', '-c', configPath], { windowsHide: true });
  const stderr = [];
  child.stderr.on('data', (data) => stderr.push(String(data)));
  child.once('error', (error) => stderr.push(error.message));
  try {
    await waitForPort(port, '127.0.0.1', 5000);
    const latencyMs = await probeProxy(port, state.settings.testUrl);
    return { id: node.id, ok: true, latencyMs };
  } catch (error) {
    const detail = stderr.join('\n')
      .split(/\r?\n/)
      .map((line) => stripAnsi(line).trim())
      .filter((line) => line && !/read http request: EOF/i.test(line))
      .slice(-2)
      .join(' | ');
    return { id: node.id, ok: false, error: detail || error.message || '测试失败' };
  } finally {
    await stopProcess(child, 1500);
    try {
      fs.rmSync(configPath, { force: true });
    } catch {
      // best effort
    }
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
    const results = await runLimited(targets, 3, measureNode);
    const now = new Date().toISOString();
    for (const result of results) {
      const node = state.nodes.find((item) => item.id === result.id);
      if (!node) continue;
      node.lastTestAt = now;
      if (result.ok) {
        node.status = 'up';
        node.autoDisabled = false;
        node.latencyMs = result.latencyMs;
        node.error = null;
      } else {
        node.status = 'down';
        node.autoDisabled = true;
        node.latencyMs = null;
        node.error = result.error || '测速失败';
      }
    }
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

function importNodes(text, groupName = '') {
  const raw = normalizeString(text);
  if (!raw) return [];
  const imported = [];

  try {
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.outbounds) ? parsed.outbounds : [parsed]);
    for (const item of items) {
      const node = normalizeNode({
        ...item,
        id: createId('node_'),
        name: item.name || item.tag || item.server,
        port: item.port || item.server_port,
        group: groupName || item.group || item.tag || ''
      });
      if (node) imported.push(node);
    }
    return imported;
  } catch {
    // fall through to line parser
  }

  for (const line of raw.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
    const node = parseProxyLink(line, groupName);
    if (node) imported.push(node);
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
        security: data.tls === 'tls' ? 'tls' : normalizeString(data.scy) || 'auto',
        sni: data.sni || data.host || data.add,
        transport: data.net,
        wsPath: data.path,
        wsHost: data.host,
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
      transport: normalizeString(params.get('type') || params.get('transport')),
      wsPath: normalizeString(params.get('path')),
      wsHost: normalizeString(params.get('host')),
      serviceName: normalizeString(params.get('serviceName') || params.get('service_name')),
      pbk: normalizeString(params.get('pbk')),
      sid: normalizeString(params.get('sid')),
      flow: normalizeString(params.get('flow')),
      fingerprint: normalizeString(params.get('fp') || params.get('fingerprint') || params.get('utls')),
      insecure: ['1', 'true', 'yes'].includes(normalizeString(params.get('allowInsecure') || params.get('insecure')).toLowerCase())
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
        uuid: decodeURIComponent(url.username || '')
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
        security: 'tls'
      });
    }
    if (scheme === 'tuic') {
      return normalizeNode({
        ...common,
        type: 'tuic',
        uuid: decodeURIComponent(url.username || ''),
        password: decodeURIComponent(url.password || ''),
        security: 'tls'
      });
    }
  } catch {
    return null;
  }
  return null;
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
  if (!password && method.includes(':')) {
    const parts = method.split(':');
    method = parts.shift();
    password = parts.join(':');
  }
  return normalizeNode({
    id: createId('node_'),
    type: 'shadowsocks',
    name: name || url.hostname,
    server: url.hostname,
    port: url.port,
    method,
    password,
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
      activeGroupId: normalizeString(body.activeGroupId) || state.settings.activeGroupId
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
    const imported = importNodes(body.text || '', body.group || '');
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

setInterval(() => {
  void runAutoTestIfDue();
  void runAutoSwitchIfDue();
}, TEST_TICK_MS).unref?.();

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
