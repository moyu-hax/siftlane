'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

process.env.SIFTLANE_DATA_DIR = path.join(os.tmpdir(), `siftlane-test-${process.pid}`);

const {
  normalizeNode,
  parseProxyLink,
  buildNodeOutbound,
  buildSpeedtestConfig,
  applySpeedtestResultsToNodes,
  decideBestSwitch
} = require('../src/server');

function buildParsedOutbound(link) {
  const node = parseProxyLink(link, 'test-group');
  assert.ok(node);
  return {
    node,
    outbound: buildNodeOutbound(node)
  };
}

test('boots with persisted nodes before normalizing UUID fields', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftlane-boot-'));
  const uuid = '4513ab13-da2c-4f79-acbc-23e8f138e73e';
  try {
    fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({
      version: 1,
      settings: {},
      nodes: [{
        id: 'boot-node',
        type: 'vless',
        name: 'boot node',
        server: 'boot.example.com',
        port: 443,
        uuid: `${uuid}:${uuid}`
      }],
      groups: []
    }));

    execFileSync(process.execPath, [
      '-e',
      `process.env.SIFTLANE_DATA_DIR=${JSON.stringify(dataDir)}; require(${JSON.stringify(path.join(__dirname, '..', 'src', 'server.js'))});`
    ], { stdio: 'pipe' });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('parses VMess TLS without using tls as VMess cipher', () => {
  const payload = Buffer.from(JSON.stringify({
    v: '2',
    ps: 'vmess tls',
    add: 'vmess.example.com',
    port: '443',
    id: '11111111-1111-4111-8111-111111111111',
    aid: '0',
    scy: 'auto',
    tls: 'tls',
    sni: 'edge.example.com',
    net: 'ws',
    host: 'cdn.example.com',
    path: '/vmess?ed=2048'
  })).toString('base64');

  const { node, outbound } = buildParsedOutbound(`vmess://${payload}`);

  assert.equal(node.security, 'auto');
  assert.equal(node.tls, true);
  assert.equal(node.wsPath, '/vmess');
  assert.equal(node.maxEarlyData, 2048);
  assert.equal(outbound.security, 'auto');
  assert.equal(outbound.packet_encoding, 'packetaddr');
  assert.equal(outbound.tls.server_name, 'edge.example.com');
  assert.equal(outbound.transport.max_early_data, 2048);
  assert.equal(outbound.transport.early_data_header_name, 'Sec-WebSocket-Protocol');
});

test('builds VLESS Reality outbound with fingerprint and spider_x', () => {
  const link = 'vless://22222222-2222-4222-8222-222222222222@reality.example.com:443?encryption=none&security=reality&type=tcp&sni=www.tesla.com&fp=firefox&pbk=PUBLICKEY&sid=0b&spx=%2F&flow=xtls-rprx-vision#reality';
  const { node, outbound } = buildParsedOutbound(link);

  assert.equal(node.security, 'reality');
  assert.equal(node.packetEncoding, '');
  assert.equal(outbound.packet_encoding, 'xudp');
  assert.equal(outbound.flow, 'xtls-rprx-vision');
  assert.deepEqual(outbound.tls.reality, {
    enabled: true,
    public_key: 'PUBLICKEY',
    short_id: '0b',
    spider_x: '/'
  });
  assert.deepEqual(outbound.tls.utls, {
    enabled: true,
    fingerprint: 'firefox'
  });
});

test('cleans duplicated UUID values before building UUID based outbounds', () => {
  const uuid = '4513ab13-da2c-4f79-acbc-23e8f138e73e';
  const duplicated = `${uuid}:${uuid}`;
  const node = normalizeNode({
    id: 'dup-vless',
    type: 'vless',
    server: 'dup.example.com',
    port: 443,
    uuid: duplicated
  });
  assert.equal(node.uuid, uuid);
  assert.equal(buildNodeOutbound(node).uuid, uuid);

  const payload = Buffer.from(JSON.stringify({
    ps: 'dup vmess',
    add: 'dup-vmess.example.com',
    port: '443',
    id: duplicated
  })).toString('base64');
  const parsed = parseProxyLink(`vmess://${payload}`, 'test-group');
  assert.equal(parsed.uuid, uuid);
  assert.equal(buildNodeOutbound(parsed).uuid, uuid);

  const compact = normalizeNode({
    id: 'compact-vless',
    type: 'vless',
    server: 'compact.example.com',
    port: 443,
    uuid: '4513ab13da2c4f79acbc23e8f138e73e'
  });
  assert.equal(compact.uuid, uuid);
});

test('cleans WebSocket early data from path and maps it to transport fields', () => {
  const link = 'vless://33333333-3333-4333-8333-333333333333@ws.example.com:443?security=tls&type=ws&host=cdn.example.com&path=%2Fvless%3Fed%3D2560%26foo%3Dbar&packet_encoding=packetaddr&early_data_header_name=X-Early-Data#ws';
  const { node, outbound } = buildParsedOutbound(link);

  assert.equal(node.wsPath, '/vless?foo=bar');
  assert.equal(node.maxEarlyData, 2560);
  assert.equal(outbound.packet_encoding, 'packetaddr');
  assert.equal(outbound.transport.path, '/vless?foo=bar');
  assert.equal(outbound.transport.headers.Host, 'cdn.example.com');
  assert.equal(outbound.transport.max_early_data, 2560);
  assert.equal(outbound.transport.early_data_header_name, 'X-Early-Data');
});

test('builds Hysteria2 outbound with obfs, bandwidth and h3 alpn without utls', () => {
  const link = 'hysteria2://pass123@hy.example.com:443?obfs=salamander&obfs-password=secret&upmbps=50&downmbps=100&heartbeat=10s&sni=hy-sni.example.com&insecure=1#hy2';
  const { outbound } = buildParsedOutbound(link);

  assert.deepEqual(outbound.obfs, {
    type: 'salamander',
    password: 'secret'
  });
  assert.equal(outbound.up_mbps, 50);
  assert.equal(outbound.down_mbps, 100);
  assert.equal(outbound.heartbeat, '10s');
  assert.deepEqual(outbound.tls.alpn, ['h3']);
  assert.equal(outbound.tls.insecure, true);
  assert.equal(outbound.tls.utls, undefined);
});

test('builds TUIC outbound with relay options and h3 alpn without utls', () => {
  const link = 'tuic://44444444-4444-4444-8444-444444444444:pass456@tuic.example.com:443?congestion_control=cubic&udp_relay_mode=native&heartbeat=15s&sni=tuic-sni.example.com&fp=chrome#tuic';
  const { outbound } = buildParsedOutbound(link);

  assert.equal(outbound.uuid, '44444444-4444-4444-8444-444444444444');
  assert.equal(outbound.password, 'pass456');
  assert.equal(outbound.congestion_control, 'cubic');
  assert.equal(outbound.udp_relay_mode, 'native');
  assert.equal(outbound.heartbeat, '15s');
  assert.deepEqual(outbound.tls.alpn, ['h3']);
  assert.equal(outbound.tls.utls, undefined);
});

test('normalizes sing-box style transport and tls objects without losing fields', () => {
  const node = normalizeNode({
    id: 'json-node',
    type: 'vless',
    server: 'json.example.com',
    server_port: 443,
    uuid: '55555555-5555-4555-8555-555555555555',
    packet_encoding: 'packetaddr',
    transport: {
      type: 'grpc',
      service_name: 'grpc-service'
    },
    tls: {
      enabled: true,
      server_name: 'json-sni.example.com',
      alpn: ['h2'],
      utls: { fingerprint: 'chrome' }
    }
  });
  const outbound = buildNodeOutbound(node);

  assert.equal(outbound.packet_encoding, 'packetaddr');
  assert.equal(outbound.transport.service_name, 'grpc-service');
  assert.deepEqual(outbound.tls.alpn, ['h2']);
  assert.deepEqual(outbound.tls.utls, {
    enabled: true,
    fingerprint: 'chrome'
  });
});

test('builds one speedtest config with one socks inbound per node', () => {
  const nodes = [
    normalizeNode({
      id: 'node-a',
      type: 'vless',
      server: 'a.example.com',
      port: 443,
      uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    }),
    normalizeNode({
      id: 'node-b',
      type: 'trojan',
      server: 'b.example.com',
      port: 443,
      password: 'pass',
      security: 'tls'
    })
  ];
  const ports = new Map([
    ['node-a', 19001],
    ['node-b', 19002]
  ]);

  const config = buildSpeedtestConfig(nodes, ports);

  assert.deepEqual(config.inbounds.map((item) => ({
    type: item.type,
    tag: item.tag,
    port: item.listen_port
  })), [
    { type: 'socks', tag: 'in-node-a', port: 19001 },
    { type: 'socks', tag: 'in-node-b', port: 19002 }
  ]);
  assert.deepEqual(config.route.rules, [
    { inbound: ['in-node-a'], outbound: 'out-node-a' },
    { inbound: ['in-node-b'], outbound: 'out-node-b' }
  ]);
  assert.deepEqual(config.outbounds.map((item) => item.tag), ['out-node-a', 'out-node-b', 'direct']);
});

test('speedtest config skips UUID based nodes with invalid UUID', () => {
  const bad = normalizeNode({
    id: 'bad-vless',
    type: 'vless',
    server: 'bad.example.com',
    port: 443,
    uuid: 'not-a-valid-uuid'
  });
  const good = normalizeNode({
    id: 'good-vless',
    type: 'vless',
    server: 'good.example.com',
    port: 443,
    uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  });
  const ports = new Map([
    ['bad-vless', 19011],
    ['good-vless', 19012]
  ]);

  const config = buildSpeedtestConfig([bad, good], ports);

  assert.deepEqual(config.inbounds.map((item) => item.tag), ['in-good-vless']);
  assert.deepEqual(config.route.rules, [
    { inbound: ['in-good-vless'], outbound: 'out-good-vless' }
  ]);
  assert.deepEqual(config.outbounds.map((item) => item.tag), ['out-good-vless', 'direct']);
});

test('updates speedtest state with failure threshold and success recovery', () => {
  const now = '2026-05-24T00:00:00.000Z';
  const nodes = [
    normalizeNode({
      id: 'node-state',
      type: 'trojan',
      server: 'state.example.com',
      port: 443,
      password: 'pass',
      security: 'tls'
    })
  ];

  applySpeedtestResultsToNodes(nodes, [{ id: 'node-state', ok: false, error: '请求超时' }], now);
  assert.equal(nodes[0].status, 'down');
  assert.equal(nodes[0].failCount, 1);
  assert.equal(nodes[0].successCount, 0);
  assert.equal(nodes[0].autoDisabled, false);
  assert.equal(nodes[0].error, '请求超时');
  assert.equal(nodes[0].lastTestAt, now);

  applySpeedtestResultsToNodes(nodes, [{ id: 'node-state', ok: false, error: '连接被拒绝' }], now);
  applySpeedtestResultsToNodes(nodes, [{ id: 'node-state', ok: false, error: '连接被拒绝' }], now);
  assert.equal(nodes[0].failCount, 3);
  assert.equal(nodes[0].autoDisabled, true);

  applySpeedtestResultsToNodes(nodes, [{ id: 'node-state', ok: true, latencyMs: 123 }], now);
  assert.equal(nodes[0].status, 'up');
  assert.equal(nodes[0].failCount, 0);
  assert.equal(nodes[0].successCount, 1);
  assert.equal(nodes[0].autoDisabled, false);
  assert.equal(nodes[0].latencyMs, 123);
  assert.equal(nodes[0].error, null);
});

function makeSwitchNode(id, latencyMs, extra = {}) {
  return normalizeNode({
    id,
    type: 'trojan',
    server: `${id}.example.com`,
    port: 443,
    password: 'pass',
    security: 'tls',
    status: 'up',
    latencyMs,
    ...extra
  });
}

test('best switch requires at least 80ms latency improvement', () => {
  const nowMs = Date.parse('2026-05-24T12:00:00.000Z');
  const lastSwitchAt = '2026-05-24T11:50:00.000Z';
  const current = makeSwitchNode('current', 200);
  const notEnough = makeSwitchNode('not-enough', 121);
  const enough = makeSwitchNode('enough', 120);

  assert.equal(decideBestSwitch({
    nodes: [current, notEnough],
    selectedNodeId: 'current',
    lastSwitchAt,
    nowMs
  }), null);

  const decision = decideBestSwitch({
    nodes: [current, enough],
    selectedNodeId: 'current',
    lastSwitchAt,
    nowMs
  });
  assert.equal(decision.node.id, 'enough');
  assert.equal(decision.reason, 'better_latency');
});

test('best switch respects five minute cooldown for latency improvements', () => {
  const nodes = [
    makeSwitchNode('current', 300),
    makeSwitchNode('best', 100)
  ];

  assert.equal(decideBestSwitch({
    nodes,
    selectedNodeId: 'current',
    lastSwitchAt: '2026-05-24T11:59:00.000Z',
    nowMs: Date.parse('2026-05-24T12:00:00.000Z')
  }), null);

  const decision = decideBestSwitch({
    nodes,
    selectedNodeId: 'current',
    lastSwitchAt: '2026-05-24T11:55:00.000Z',
    nowMs: Date.parse('2026-05-24T12:00:00.000Z')
  });
  assert.equal(decision.node.id, 'best');
  assert.equal(decision.reason, 'better_latency');
});

test('best switch moves away after current node fails twice', () => {
  const currentFailedOnce = makeSwitchNode('current', 80, {
    status: 'down',
    failCount: 1,
    latencyMs: null
  });
  const currentFailedTwice = makeSwitchNode('current', 80, {
    status: 'down',
    failCount: 2,
    latencyMs: null
  });
  const best = makeSwitchNode('best', 150);
  const recentSwitchAt = '2026-05-24T11:59:00.000Z';
  const nowMs = Date.parse('2026-05-24T12:00:00.000Z');

  assert.equal(decideBestSwitch({
    nodes: [currentFailedOnce, best],
    selectedNodeId: 'current',
    lastSwitchAt: recentSwitchAt,
    nowMs
  }), null);

  const decision = decideBestSwitch({
    nodes: [currentFailedTwice, best],
    selectedNodeId: 'current',
    lastSwitchAt: recentSwitchAt,
    nowMs
  });
  assert.equal(decision.node.id, 'best');
  assert.equal(decision.reason, 'current_failed');
});
