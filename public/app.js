const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));
const DEFAULT_GROUP_NAME = '默认分组';

const state = {
  data: null,
  setupRequired: false,
  view: 'dashboard',
  selectedNodeIds: new Set(),
  nodeGroupFilter: ''
};

async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return payload;
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add('hidden'), 2800);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function formatTime(value) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleString('zh-CN', { hour12: false });
}

function formatDuration(seconds) {
  const total = Number(seconds || 0);
  if (!Number.isFinite(total) || total <= 0) return '--';
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = Math.floor(total % 60);
  if (days) return `${days}天 ${hours}小时`;
  if (hours) return `${hours}小时 ${minutes}分`;
  if (minutes) return `${minutes}分 ${secs}秒`;
  return `${secs}秒`;
}

function statusText(status) {
  return {
    running: '运行中',
    stopped: '已停止',
    starting: '启动中',
    error: '异常'
  }[status] || status || '--';
}

function usableNode(node) {
  return Boolean(node && node.enabled !== false && !node.autoDisabled);
}

function getNodeById(id) {
  return state.data?.nodes.find((node) => node.id === id) || null;
}

function groupNodes(group) {
  const ids = new Set(group?.nodeIds || []);
  return (state.data?.nodes || []).filter((node) => ids.has(node.id));
}

function nodeGroupName(node) {
  return String(node?.group || '').trim() || DEFAULT_GROUP_NAME;
}

function groupSubscriptions(group) {
  if (Array.isArray(group?.subscriptions) && group.subscriptions.length) return group.subscriptions;
  const legacyUrl = String(group?.subscriptionUrl || '').trim();
  if (!legacyUrl) return [];
  return [{
    id: 'legacy-subscription',
    name: String(group?.subscriptionName || '').trim() || legacyUrl,
    url: legacyUrl,
    enabled: true,
    lastSyncAt: group?.subscriptionLastSyncAt || null,
    lastError: group?.subscriptionLastError || null,
    lastCount: group?.subscriptionLastCount || 0
  }];
}

function getSubscriptionById(group, subscriptionId) {
  const id = String(subscriptionId || '').trim();
  return groupSubscriptions(group).find((subscription) => subscription.id === id) || null;
}

function nodeGroupNames(data = state.data) {
  return Array.from(new Set((data?.nodes || []).map(nodeGroupName))).sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

function visibleNodes(data = state.data) {
  const nodes = data?.nodes || [];
  return state.nodeGroupFilter ? nodes.filter((node) => nodeGroupName(node) === state.nodeGroupFilter) : nodes;
}

function renderNodeGroupFilter(data = state.data) {
  const select = $('#nodeGroupFilter');
  if (!select) return;
  const groups = nodeGroupNames(data);
  if (state.nodeGroupFilter && !groups.includes(state.nodeGroupFilter)) state.nodeGroupFilter = '';
  select.innerHTML = '<option value="">全部分组</option>' + groups.map((group) => '<option value="' + escapeHtml(group) + '"' + (group === state.nodeGroupFilter ? ' selected' : '') + '>' + escapeHtml(group) + '</option>').join('');
}

function getGroupById(id) {
  return state.data?.groups.find((group) => group.id === id) || null;
}

function renderGroupNameList(data) {
  const list = $('#groupNameList');
  if (!list) return;
  list.innerHTML = (data.groups || []).map((group) => `<option value="${escapeHtml(group.name)}"></option>`).join('');
}

function fillSubscriptionForm(group, subscription = null) {
  const groupIdInput = $('#subscriptionGroupId');
  const subscriptionIdInput = $('#subscriptionId');
  const nameInput = $('#subscriptionGroupName');
  const subscriptionNameInput = $('#subscriptionName');
  const urlInput = $('#subscriptionUrl');
  const intervalInput = $('#subscriptionIntervalMin');
  if (groupIdInput) groupIdInput.value = group?.id || '';
  if (subscriptionIdInput) subscriptionIdInput.value = subscription?.id || '';
  if (nameInput) nameInput.value = group?.name || '';
  if (subscriptionNameInput) subscriptionNameInput.value = subscription?.name || '';
  if (urlInput) urlInput.value = subscription?.url || '';
  if (intervalInput) intervalInput.value = group?.subscriptionUpdateIntervalMin || 60;
  (urlInput || nameInput)?.focus?.();
  if (subscription) urlInput?.select?.();
}

function renderFirewall(data) {
  const firewall = data.firewall || {};
  const status = $('#firewallStatus');
  if (status) status.textContent = firewall.available ? '可用' : `不可用${firewall.error ? `：${firewall.error}` : ''}`;
  const source = $('#firewallSource');
  if (source && !source.value) source.value = '172.22.0.0/16';
  const httpPort = $('#firewallHttpPort');
  if (httpPort) httpPort.textContent = data.settings.httpPort || '--';
  const socksPort = $('#firewallSocksPort');
  if (socksPort) socksPort.textContent = data.settings.socksPort || '--';
  const rules = $('#firewallRules');
  if (!rules) return;
  if (!firewall.available) {
    rules.innerHTML = `<div class="muted">${escapeHtml(firewall.error || 'iptables 不可用')}</div>`;
    return;
  }
  if (!firewall.rules.length) {
    rules.innerHTML = '<div class="muted">暂无放行规则</div>';
    return;
  }
  rules.innerHTML = firewall.rules.map((rule) => `<div class="firewall-rule"><code>${escapeHtml(rule)}</code></div>`).join('');
}

function pruneSelectedNodes(data) {
  const validIds = new Set((data?.nodes || []).map((node) => node.id));
  for (const id of Array.from(state.selectedNodeIds)) {
    if (!validIds.has(id)) state.selectedNodeIds.delete(id);
  }
}

function selectedNodeIds() {
  pruneSelectedNodes(state.data);
  return Array.from(state.selectedNodeIds);
}

function updateBulkSelectionUi(data = state.data) {
  const nodes = visibleNodes(data);
  const visibleIds = new Set(nodes.map((node) => node.id));
  const selected = selectedNodeIds();
  const count = selected.length;
  const visibleSelectedCount = selected.filter((id) => visibleIds.has(id)).length;
  const countEl = $('#selectedNodeCount');
  if (countEl) countEl.textContent = `已选 ${count} 个`;

  const selectAll = $('#selectAllNodes');
  if (selectAll) {
    selectAll.checked = nodes.length > 0 && visibleSelectedCount === nodes.length;
    selectAll.indeterminate = visibleSelectedCount > 0 && visibleSelectedCount < nodes.length;
  }

  ['#batchGroupBtn', '#batchEnableBtn', '#batchDisableBtn', '#batchTestBtn', '#batchDeleteBtn'].forEach((selector) => {
    const button = $(selector);
    if (button) button.disabled = count === 0;
  });
}

function nodeBadge(node) {
  if (node.enabled === false) return '<span class="pill warn">手动禁用</span>';
  if (node.autoDisabled) return '<span class="pill bad">已禁用</span>';
  if (node.status === 'up') return '<span class="pill good">可用</span>';
  if (node.status === 'down') return '<span class="pill bad">失败</span>';
  return '<span class="pill">未测速</span>';
}

async function checkSession() {
  const session = await request('/api/session');
  state.setupRequired = session.setupRequired;
  if (session.authenticated) {
    $('#loginView').classList.add('hidden');
    $('#appView').classList.remove('hidden');
    await loadState();
  } else {
    $('#loginView').classList.remove('hidden');
    $('#appView').classList.add('hidden');
    $('#authModeText').textContent = session.setupRequired ? '设置 Web 密码' : '登录';
    $('#authSubmit').textContent = session.setupRequired ? '保存密码' : '登录';
  }
}

async function loadState() {
  state.data = await request('/api/state');
  render();
}

function setView(view) {
  state.view = view;
  const titles = {
    dashboard: '仪表盘',
    groups: '节点组',
    settings: '设置'
  };
  $('#pageTitle').textContent = titles[view] || '仪表盘';
  $$('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.nav === view));
  $$('.view').forEach((panel) => panel.classList.toggle('hidden', panel.id !== `view-${view}`));
}

function setSwitchModeUi(mode) {
  const activeMode = mode === 'auto' ? 'auto' : 'manual';
  $('#modeManualBtn').classList.toggle('active', activeMode === 'manual');
  $('#modeAutoBtn').classList.toggle('active', activeMode === 'auto');
  $('#manualModePanel').classList.toggle('hidden', activeMode !== 'manual');
  $('#autoModePanel').classList.toggle('hidden', activeMode !== 'auto');
}

function selectedSwitchMode() {
  return $('#modeAutoBtn').classList.contains('active') ? 'auto' : 'manual';
}

function render() {
  const data = state.data;
  if (!data) return;
  setView(state.view);
  renderDashboard(data);
  renderGroups(data);
  renderGroupSettings(data);
  renderNodes(data);
  renderSettings(data);
}

function currentUptimeSec(data = state.data) {
  if (!data || data.core?.status !== 'running') return 0;
  const startedAt = Date.parse(data.core?.startedAt || '');
  if (!Number.isFinite(startedAt) || startedAt <= 0) return data.dashboard?.uptimeSec || 0;
  return Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
}

function updateUptimeText(data = state.data) {
  const el = $('#uptimeText');
  if (el) el.textContent = formatDuration(currentUptimeSec(data));
}

function renderDashboard(data) {
  const healthy = data.nodes.filter(usableNode).length;
  const current = data.dashboard?.currentNode || null;
  $('#coreStatus').textContent = statusText(data.core.status);
  updateUptimeText(data);
  $('#healthyCount').textContent = `${healthy}/${data.nodes.length}`;
  $('#lastTestAt').textContent = formatTime(data.settings.lastTestAt);
  $('#testingFlag').textContent = data.testing ? '测速中' : '';
  $('#currentOutboundName').textContent = current?.name || '--';
  $('#currentOutboundGroup').textContent = current?.group || '--';
  $('#nextSwitchAt').textContent = formatTime(data.dashboard?.nextSwitchAt);
  $('#logs').textContent = (data.core.logs || []).map((item) => `[${formatTime(item.at)}] ${item.line}`).join('\n');

  setSwitchModeUi(data.settings.switchMode);
  renderManualNodeSelect(data);
  renderAutoGroupSelect(data);
  $('#autoIntervalInput').value = data.settings.autoSwitchIntervalMin || 10;
}

function renderManualNodeSelect(data) {
  const select = $('#manualNodeSelect');
  const selectedId = data.settings.manualNodeId || data.dashboard?.currentNode?.id || '';
  const grouped = new Map();
  for (const node of data.nodes.filter(usableNode)) {
    const groupName = node.group || '未分组';
    if (!grouped.has(groupName)) grouped.set(groupName, []);
    grouped.get(groupName).push(node);
  }

  let html = '';
  for (const [groupName, nodes] of grouped.entries()) {
    html += `<optgroup label="${escapeHtml(groupName)}">`;
    html += nodes.map((node) => `<option value="${escapeHtml(node.id)}"${node.id === selectedId ? ' selected' : ''}>${escapeHtml(node.name)}</option>`).join('');
    html += '</optgroup>';
  }
  select.innerHTML = html || '<option value="">暂无可用节点</option>';
}

function renderAutoGroupSelect(data) {
  const select = $('#autoGroupSelect');
  if (!data.groups.length) {
    select.innerHTML = '<option value="">暂无分组</option>';
    return;
  }
  select.innerHTML = data.groups.map((group) => {
    const nodes = groupNodes(group);
    const usable = nodes.filter(usableNode);
    const disabled = usable.length ? '' : ' disabled';
    const selected = group.id === data.settings.activeGroupId ? ' selected' : '';
    return `<option value="${escapeHtml(group.id)}"${selected}${disabled}>${escapeHtml(group.name)} (${usable.length}/${nodes.length})</option>`;
  }).join('');
}

function renderGroups(data) {
  const wrap = $('#groupsList');
  if (!data.groups.length) {
    wrap.innerHTML = '<div class="muted">暂无分组。导入节点时填分组名后会自动同步。</div>';
    const list = $('#groupNameList');
    if (list) list.innerHTML = '';
    return;
  }

  renderGroupNameList(data);
  wrap.innerHTML = data.groups.map((group) => {
    const nodes = groupNodes(group);
    const usable = nodes.filter(usableNode);
    const selected = getNodeById(group.selectedNodeId);
    const interval = group.subscriptionUpdateIntervalMin || 60;
    const subscriptions = groupSubscriptions(group);
    const options = nodes.map((node) => {
      const disabled = usableNode(node) ? '' : ' disabled';
      const label = node.name + (usableNode(node) ? '' : '（不可用）');
      const selectedAttr = node.id === group.selectedNodeId ? ' selected' : '';
      return '<option value="' + escapeHtml(node.id) + '"' + selectedAttr + disabled + '>' + escapeHtml(label) + '</option>';
    }).join('');
    const subscriptionSummary = subscriptions.length
      ? '<div class="group-subscriptions">' + subscriptions.map((subscription) => {
          const enabled = subscription.enabled !== false;
          const statusClass = subscription.lastError ? 'bad' : (enabled ? 'good' : 'warn');
          const statusText = subscription.lastError ? '异常' : (enabled ? '启用' : '禁用');
          const title = subscription.name || '订阅';
          const error = subscription.lastError
            ? '<div class="node-meta node-error" title="' + escapeHtml(subscription.lastError) + '">错误：' + escapeHtml(subscription.lastError) + '</div>'
            : '';
          return '<div class="group-subscription-item">'
            + '<div class="group-subscription-main">'
            + '<div class="group-subscription-head"><strong title="' + escapeHtml(title) + '">' + escapeHtml(title) + '</strong><span class="pill ' + statusClass + '">' + statusText + '</span><span class="pill">' + (subscription.lastCount || 0) + ' 个</span></div>'
            + '<div class="node-meta group-subscription-url" title="' + escapeHtml(subscription.url) + '">' + escapeHtml(subscription.url) + '</div>'
            + '<div class="node-meta">上次：' + formatTime(subscription.lastSyncAt) + ' · 间隔：' + interval + ' 分钟</div>'
            + error
            + '</div>'
            + '<div class="group-subscription-actions">'
            + '<button data-subscription-edit="' + escapeHtml(group.id) + '" data-subscription-id="' + escapeHtml(subscription.id) + '" type="button">编辑</button>'
            + '<button data-subscription-sync="' + escapeHtml(group.id) + '" data-subscription-id="' + escapeHtml(subscription.id) + '" type="button">同步</button>'
            + '<button data-subscription-delete="' + escapeHtml(group.id) + '" data-subscription-id="' + escapeHtml(subscription.id) + '" type="button">删除</button>'
            + '</div>'
            + '</div>';
        }).join('') + '</div>'
      : '<div class="node-meta">未配置订阅</div>';
    const syncAllButton = subscriptions.length
      ? '<button data-group-subscription-sync="' + escapeHtml(group.id) + '" type="button">同步全部</button>'
      : '';
    const groupError = group.subscriptionLastError
      ? '<div class="node-meta node-error" title="' + escapeHtml(group.subscriptionLastError) + '">订阅错误：' + escapeHtml(group.subscriptionLastError) + '</div>'
      : '';
    return '<article class="group-item">'
      + '<div>'
      + '<div class="group-title"><strong>' + escapeHtml(group.name) + '</strong>'
      + (group.id === data.settings.activeGroupId ? '<span class="pill good">活动</span>' : '')
      + '<span class="pill">' + usable.length + '/' + nodes.length + '</span>'
      + '<span class="pill">订阅 ' + subscriptions.length + '</span></div>'
      + '<div class="node-meta">当前：' + escapeHtml(selected?.name || '--') + '</div>'
      + '<div class="node-meta">订阅同步：' + formatTime(group.subscriptionLastSyncAt) + ' · 总计：' + (group.subscriptionLastCount || 0) + ' 个</div>'
      + groupError
      + subscriptionSummary
      + '</div>'
      + '<div class="group-actions">'
      + '<select data-group-select="' + escapeHtml(group.id) + '">' + (options || '<option value="">无节点</option>') + '</select>'
      + '<button data-group-subscription-add="' + escapeHtml(group.id) + '" type="button">添加订阅</button>'
      + syncAllButton
      + '<button data-group-active="' + escapeHtml(group.id) + '" type="button">设为活动</button>'
      + '<button data-group-test="' + escapeHtml(group.id) + '" type="button">测速</button>'
      + '<button data-group-delete="' + escapeHtml(group.id) + '" type="button">删除</button>'
      + '</div>'
      + '</article>';
  }).join('');
}

function renderGroupSettings(data) {
  const input = $('#groupTestIntervalMin');
  if (input) {
    input.value = Math.max(1, Math.round((data.settings.testIntervalSec || 300) / 60));
  }
}

function renderNodes(data) {
  renderNodeGroupFilter(data);
  const nodes = visibleNodes(data);
  const total = data.nodes.length;
  $('#nodeCount').textContent = state.nodeGroupFilter
    ? `当前分组 ${nodes.length}/${total} 个节点`
    : `${total} 个节点`;
  const body = $('#nodesTable');
  pruneSelectedNodes(data);
  if (!total) {
    body.innerHTML = '<tr><td colspan="7" class="muted">暂无节点</td></tr>';
    updateBulkSelectionUi(data);
    return;
  }
  if (!nodes.length) {
    body.innerHTML = '<tr><td colspan="7" class="muted">当前分组暂无节点</td></tr>';
    updateBulkSelectionUi(data);
    return;
  }
  body.innerHTML = nodes.map((node) => {
    const errorText = node.error || '';
    return `
    <tr class="${state.selectedNodeIds.has(node.id) ? 'selected-row' : ''}">
      <td class="check-cell"><input class="node-check" type="checkbox" data-node-select="${escapeHtml(node.id)}"${state.selectedNodeIds.has(node.id) ? ' checked' : ''}></td>
      <td>
        <div class="node-name">${escapeHtml(node.name)}</div>
        <div class="node-meta">${escapeHtml(node.type.toUpperCase())}</div>
      </td>
      <td>${escapeHtml(nodeGroupName(node))}</td>
      <td>
        <div class="node-address">${escapeHtml(node.server)}:${escapeHtml(node.port)}</div>
        <div class="node-meta node-error" title="${escapeHtml(errorText)}">${escapeHtml(errorText)}</div>
      </td>
      <td>${nodeBadge(node)}</td>
      <td>${node.latencyMs == null ? '--' : `${escapeHtml(node.latencyMs)} ms`}</td>
      <td>
        <div class="row-actions">
          <button data-node-test="${escapeHtml(node.id)}" type="button">测速</button>
          <button data-node-toggle="${escapeHtml(node.id)}" type="button">${node.enabled === false ? '启用' : '禁用'}</button>
          <button data-node-group="${escapeHtml(node.id)}" type="button">分组</button>
          <button data-node-delete="${escapeHtml(node.id)}" type="button">删除</button>
        </div>
      </td>
    </tr>`;
  }).join('');
  updateBulkSelectionUi(data);
}

function renderSettings(data) {
  $('#settingSingBox').value = data.settings.singBoxPath || '';
  $('#settingTestUrl').value = data.settings.testUrl || '';
  $('#settingSubscriptionConverter').value = data.settings.subscriptionConverterUrl || '';
  $('#settingInterval').value = data.settings.testIntervalSec || 300;
  $('#settingProxyHost').value = data.settings.proxyListenHost || '';
  $('#settingHttpPort').value = data.settings.httpPort || '';
  $('#settingSocksPort').value = data.settings.socksPort || '';
  $('#coreListenInfo').textContent = `${data.settings.proxyListenHost}:${data.settings.httpPort} / SOCKS ${data.settings.socksPort}`;
  renderFirewall(data);
}

async function runAction(fn, success) {
  try {
    await fn();
    if (success) toast(success);
    await loadState();
  } catch (error) {
    toast(error.message);
  }
}

function getSelectedNodeIdsOrToast() {
  const ids = selectedNodeIds();
  if (!ids.length) toast('请先勾选节点');
  return ids;
}

async function updateSelectedNodes(ids, patch) {
  for (const id of ids) {
    await request(`/api/nodes/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(typeof patch === 'function' ? patch(id) : patch)
    });
  }
}

async function deleteSelectedNodes(ids) {
  for (const id of ids) {
    await request(`/api/nodes/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
  state.selectedNodeIds.clear();
}

$('#authForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#authError').classList.add('hidden');
  const password = $('#authPassword').value;
  try {
    await request(state.setupRequired ? '/api/setup' : '/api/login', {
      method: 'POST',
      body: JSON.stringify({ password })
    });
    $('#authPassword').value = '';
    await checkSession();
  } catch (error) {
    $('#authError').textContent = error.message;
    $('#authError').classList.remove('hidden');
  }
});

$('#logoutBtn').addEventListener('click', () => runAction(async () => {
  await request('/api/logout', { method: 'POST', body: '{}' });
  await checkSession();
}, '已退出'));

$('#refreshBtn').addEventListener('click', () => runAction(loadState));
$('#startCoreBtn').addEventListener('click', () => runAction(() => request('/api/core/start', { method: 'POST', body: '{}' }), '核心已启动'));
$('#stopCoreBtn').addEventListener('click', () => runAction(() => request('/api/core/stop', { method: 'POST', body: '{}' }), '核心已停止'));
$('#restartCoreBtn').addEventListener('click', () => runAction(() => request('/api/core/restart', { method: 'POST', body: '{}' }), '核心已重启'));
$('#testAllBtn').addEventListener('click', () => runAction(() => request('/api/test', { method: 'POST', body: '{}' }), '测速完成'));

$('#batchGroupBtn').addEventListener('click', () => {
  const ids = getSelectedNodeIdsOrToast();
  if (!ids.length) return;
  const group = prompt('批量分组名称', '');
  if (group == null) return;
  runAction(() => updateSelectedNodes(ids, { group }), '批量分组已完成');
});

$('#batchEnableBtn').addEventListener('click', () => {
  const ids = getSelectedNodeIdsOrToast();
  if (!ids.length) return;
  runAction(() => updateSelectedNodes(ids, { enabled: true, autoDisabled: false }), '已批量启用');
});

$('#batchDisableBtn').addEventListener('click', () => {
  const ids = getSelectedNodeIdsOrToast();
  if (!ids.length) return;
  runAction(() => updateSelectedNodes(ids, { enabled: false }), '已批量禁用');
});

$('#batchTestBtn').addEventListener('click', () => {
  const ids = getSelectedNodeIdsOrToast();
  if (!ids.length) return;
  runAction(() => request('/api/test', { method: 'POST', body: JSON.stringify({ ids }) }), '批量测速完成');
});

$('#batchDeleteBtn').addEventListener('click', () => {
  const ids = getSelectedNodeIdsOrToast();
  if (!ids.length || !confirm(`删除选中的 ${ids.length} 个节点？`)) return;
  runAction(() => deleteSelectedNodes(ids), '已批量删除');
});

$('#dashboardForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const switchMode = selectedSwitchMode();
  runAction(() => request('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({
      switchMode,
      manualNodeId: $('#manualNodeSelect').value || null,
      activeGroupId: $('#autoGroupSelect').value || undefined,
      autoSwitchIntervalMin: Number($('#autoIntervalInput').value || 10)
    })
  }), '切换设置已保存');
});

$('#groupForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const name = $('#groupName').value.trim();
  if (!name) return;
  runAction(async () => {
    await request('/api/groups', { method: 'POST', body: JSON.stringify({ name }) });
    $('#groupName').value = '';
  }, '分组已创建');
});

$('#groupTestIntervalForm').addEventListener('submit', (event) => {
  event.preventDefault();
  runAction(async () => {
    const minutes = Math.max(1, Number($('#groupTestIntervalMin').value || 10));
    await request('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ testIntervalSec: minutes * 60 })
    });
  }, '自动测速间隔已保存');
});

$('#subscriptionForm').addEventListener('submit', (event) => {
  event.preventDefault();
  runAction(async () => {
    const groupId = $('#subscriptionGroupId').value.trim();
    const subscriptionId = $('#subscriptionId').value.trim();
    const groupName = $('#subscriptionGroupName').value.trim();
    const subscriptionName = $('#subscriptionName').value.trim();
    const subscriptionUrl = $('#subscriptionUrl').value.trim();
    const interval = Math.max(1, Number($('#subscriptionIntervalMin').value || 60));
    if (!groupId && !groupName) throw new Error('请输入分组名称');
    if (!subscriptionUrl) throw new Error('请输入订阅链接');
    const payload = await request('/api/groups/subscription', {
      method: 'POST',
      body: JSON.stringify({
        groupId,
        groupName,
        subscriptionId,
        subscriptionName,
        subscriptionUrl,
        subscriptionUpdateIntervalMin: interval
      })
    });
    $('#subscriptionGroupId').value = payload.groupId || groupId;
    $('#subscriptionId').value = '';
    $('#subscriptionName').value = '';
    $('#subscriptionUrl').value = '';
    if (payload.syncError) {
      toast('订阅已保存，但同步失败：' + payload.syncError);
      return;
    }
    toast('订阅已同步 ' + (payload.syncedCount || 0) + ' 个节点');
  });
});

$('#subscriptionGroupName').addEventListener('input', () => {
  $('#subscriptionGroupId').value = '';
  $('#subscriptionId').value = '';
});

$('#importForm').addEventListener('submit', (event) => {
  event.preventDefault();
  runAction(async () => {
    const payload = await request('/api/nodes/import', {
      method: 'POST',
      body: JSON.stringify({ text: $('#importText').value, group: $('#importGroup').value.trim() })
    });
    $('#importText').value = '';
    toast(`导入 ${payload.importedCount || 0} 个节点`);
  });
});

$('#nodeForm').addEventListener('submit', (event) => {
  event.preventDefault();
  runAction(async () => {
    await request('/api/nodes', {
      method: 'POST',
      body: JSON.stringify({
        type: $('#nodeType').value,
        name: $('#nodeName').value,
        group: $('#nodeGroup').value,
        server: $('#nodeServer').value,
        port: Number($('#nodePort').value),
        uuid: $('#nodeUuid').value,
        password: $('#nodePassword').value,
        method: $('#nodeMethod').value,
        security: $('#nodeSecurity').value,
        sni: $('#nodeSni').value,
        fingerprint: $('#nodeFingerprint').value,
        pbk: $('#nodePbk').value,
        sid: $('#nodeSid').value
      })
    });
    event.target.reset();
  }, '节点已保存');
});

$('#settingsForm').addEventListener('submit', (event) => {
  event.preventDefault();
  runAction(async () => {
    await request('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        singBoxPath: $('#settingSingBox').value,
        testUrl: $('#settingTestUrl').value,
        subscriptionConverterUrl: $('#settingSubscriptionConverter').value,
        testIntervalSec: Number($('#settingInterval').value),
        proxyListenHost: $('#settingProxyHost').value,
        httpPort: Number($('#settingHttpPort').value),
        socksPort: Number($('#settingSocksPort').value),
        password: $('#settingPassword').value || undefined
      })
    });
    $('#settingPassword').value = '';
  }, '设置已保存');
});

document.addEventListener('change', (event) => {
  if (event.target.id === 'nodeGroupFilter') {
    state.nodeGroupFilter = event.target.value;
    state.selectedNodeIds.clear();
    renderNodes(state.data);
    return;
  }

  if (event.target.id === 'selectAllNodes') {
    const nodes = visibleNodes(state.data);
    if (event.target.checked) {
      for (const node of nodes) state.selectedNodeIds.add(node.id);
    } else {
      for (const node of nodes) state.selectedNodeIds.delete(node.id);
    }
    renderNodes(state.data);
    return;
  }

  const nodeSelect = event.target.dataset.nodeSelect;
  if (nodeSelect) {
    if (event.target.checked) state.selectedNodeIds.add(nodeSelect);
    else state.selectedNodeIds.delete(nodeSelect);
    event.target.closest('tr')?.classList.toggle('selected-row', event.target.checked);
    updateBulkSelectionUi(state.data);
    return;
  }

  const groupId = event.target.dataset.groupSelect;
  if (!groupId) return;
  runAction(() => request(`/api/groups/${encodeURIComponent(groupId)}`, {
    method: 'PUT',
    body: JSON.stringify({ selectedNodeId: event.target.value })
  }), '已切换');
});

document.addEventListener('click', (event) => {
  const target = event.target.closest('button');
  if (!target) return;

  if (target.dataset.nav) {
    setView(target.dataset.nav);
    return;
  }

  if (target.dataset.switchMode) {
    setSwitchModeUi(target.dataset.switchMode);
    return;
  }

  const nodeTest = target.dataset.nodeTest;
  const nodeToggle = target.dataset.nodeToggle;
  const nodeDelete = target.dataset.nodeDelete;
  const nodeGroup = target.dataset.nodeGroup;
  const groupSubscriptionAdd = target.dataset.groupSubscriptionAdd;
  const groupSubscriptionSync = target.dataset.groupSubscriptionSync;
  const subscriptionEdit = target.dataset.subscriptionEdit;
  const subscriptionSync = target.dataset.subscriptionSync;
  const subscriptionDelete = target.dataset.subscriptionDelete;
  const groupActive = target.dataset.groupActive;
  const groupTest = target.dataset.groupTest;
  const groupDelete = target.dataset.groupDelete;
  const firewallAction = target.dataset.firewallAction;
  const firewallPort = target.dataset.firewallPort;

  if (nodeTest) {
    runAction(() => request('/api/test', { method: 'POST', body: JSON.stringify({ ids: [nodeTest] }) }), '测速完成');
  } else if (nodeToggle) {
    const node = getNodeById(nodeToggle);
    runAction(() => request(`/api/nodes/${encodeURIComponent(nodeToggle)}`, {
      method: 'PUT',
      body: JSON.stringify({ enabled: node?.enabled === false })
    }), '状态已更新');
  } else if (nodeDelete) {
    if (!confirm('删除这个节点？')) return;
    runAction(() => request(`/api/nodes/${encodeURIComponent(nodeDelete)}`, { method: 'DELETE' }), '节点已删除');
  } else if (nodeGroup) {
    const node = getNodeById(nodeGroup);
    const group = prompt('分组名称', node?.group || '');
    if (group == null) return;
    runAction(() => request(`/api/nodes/${encodeURIComponent(nodeGroup)}`, {
      method: 'PUT',
      body: JSON.stringify({ group })
    }), '分组已更新');
  } else if (groupSubscriptionAdd) {
    const group = getGroupById(groupSubscriptionAdd);
    if (!group) return;
    fillSubscriptionForm(group, null);
    setView('groups');
  } else if (subscriptionEdit) {
    const group = getGroupById(subscriptionEdit);
    if (!group) return;
    const subscription = getSubscriptionById(group, target.dataset.subscriptionId);
    if (!subscription) return;
    fillSubscriptionForm(group, subscription);
    setView('groups');
  } else if (groupSubscriptionSync) {
    runAction(async () => {
      const payload = await request(`/api/groups/${encodeURIComponent(groupSubscriptionSync)}/subscription-sync`, {
        method: 'POST',
        body: '{}'
      });
      if (payload.syncError) {
        toast('订阅已同步，但有错误：' + payload.syncError);
      } else {
        toast('订阅已同步');
      }
    });
  } else if (subscriptionSync) {
    const group = getGroupById(subscriptionSync);
    if (!group) return;
    const subscription = getSubscriptionById(group, target.dataset.subscriptionId);
    if (!subscription) return;
    runAction(() => request(`/api/groups/${encodeURIComponent(subscriptionSync)}/subscriptions/${encodeURIComponent(subscription.id)}/sync`, {
      method: 'POST',
      body: '{}'
    }), '订阅已同步');
  } else if (subscriptionDelete) {
    const group = getGroupById(subscriptionDelete);
    if (!group) return;
    const subscription = getSubscriptionById(group, target.dataset.subscriptionId);
    if (!subscription) return;
    if (!confirm('删除这个订阅？对应拉取的节点也会一起删除。')) return;
    runAction(() => request(`/api/groups/${encodeURIComponent(subscriptionDelete)}/subscriptions/${encodeURIComponent(subscription.id)}`, { method: 'DELETE' }), '订阅已删除');
  } else if (groupActive) {
    runAction(() => request(`/api/groups/${encodeURIComponent(groupActive)}`, {
      method: 'PUT',
      body: JSON.stringify({ active: true })
    }), '活动分组已更新');
  } else if (groupTest) {
    runAction(() => request('/api/test', { method: 'POST', body: JSON.stringify({ groupId: groupTest }) }), '分组测速完成');
  } else if (groupDelete) {
    if (!confirm('删除这个分组？该分组下的节点也会一起删除。')) return;
    runAction(() => request(`/api/groups/${encodeURIComponent(groupDelete)}`, { method: 'DELETE' }), '分组已删除');
  } else if (firewallAction) {
    runAction(() => request('/api/firewall', {
      method: 'POST',
      body: JSON.stringify({
        action: firewallAction,
        source: $('#firewallSource').value.trim(),
        port: firewallPort === 'socks'
          ? Number(state.data?.settings?.socksPort || 0)
          : Number(state.data?.settings?.httpPort || 0)
      })
    }), firewallAction === 'delete' ? '规则已删除' : '规则已开放');
  }
});

checkSession();
setInterval(() => {
  if (!$('#appView').classList.contains('hidden')) {
    updateUptimeText();
  }
}, 1000);

setInterval(() => {
  if (!$('#appView').classList.contains('hidden')) {
    loadState().catch(() => {});
  }
}, 10000);
