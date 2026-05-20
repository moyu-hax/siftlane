const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const state = {
  data: null,
  setupRequired: false,
  view: 'dashboard',
  selectedNodeIds: new Set()
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
  const nodes = data?.nodes || [];
  const selected = selectedNodeIds();
  const count = selected.length;
  const countEl = $('#selectedNodeCount');
  if (countEl) countEl.textContent = `已选 ${count} 个`;

  const selectAll = $('#selectAllNodes');
  if (selectAll) {
    selectAll.checked = nodes.length > 0 && count === nodes.length;
    selectAll.indeterminate = count > 0 && count < nodes.length;
  }

  ['#batchGroupBtn', '#batchDisableBtn', '#batchTestBtn', '#batchDeleteBtn'].forEach((selector) => {
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

function renderDashboard(data) {
  const healthy = data.nodes.filter(usableNode).length;
  const current = data.dashboard?.currentNode || null;
  $('#coreStatus').textContent = statusText(data.core.status);
  $('#uptimeText').textContent = formatDuration(data.dashboard?.uptimeSec || 0);
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
    return;
  }

  wrap.innerHTML = data.groups.map((group) => {
    const nodes = groupNodes(group);
    const usable = nodes.filter(usableNode);
    const selected = getNodeById(group.selectedNodeId);
    const options = nodes.map((node) => {
      const disabled = usableNode(node) ? '' : ' disabled';
      const label = `${node.name}${usableNode(node) ? '' : '（不可用）'}`;
      return `<option value="${escapeHtml(node.id)}"${node.id === group.selectedNodeId ? ' selected' : ''}${disabled}>${escapeHtml(label)}</option>`;
    }).join('');
    return `
      <article class="group-item">
        <div>
          <div class="group-title">
            <strong>${escapeHtml(group.name)}</strong>
            ${group.id === data.settings.activeGroupId ? '<span class="pill good">活动</span>' : ''}
            <span class="pill">${usable.length}/${nodes.length}</span>
          </div>
          <div class="node-meta">当前：${escapeHtml(selected?.name || '--')}</div>
        </div>
        <div class="group-actions">
          <select data-group-select="${escapeHtml(group.id)}">${options || '<option value="">无节点</option>'}</select>
          <button data-group-active="${escapeHtml(group.id)}" type="button">设为活动</button>
          <button data-group-test="${escapeHtml(group.id)}" type="button">测速</button>
          <button data-group-delete="${escapeHtml(group.id)}" type="button">删除</button>
        </div>
      </article>`;
  }).join('');
}

function renderGroupSettings(data) {
  const input = $('#groupTestIntervalMin');
  if (input) {
    input.value = Math.max(1, Math.round((data.settings.testIntervalSec || 300) / 60));
  }
}

function renderNodes(data) {
  $('#nodeCount').textContent = `${data.nodes.length} 个节点`;
  const body = $('#nodesTable');
  pruneSelectedNodes(data);
  if (!data.nodes.length) {
    body.innerHTML = '<tr><td colspan="7" class="muted">暂无节点</td></tr>';
    updateBulkSelectionUi(data);
    return;
  }
  body.innerHTML = data.nodes.map((node) => `
    <tr class="${state.selectedNodeIds.has(node.id) ? 'selected-row' : ''}">
      <td class="check-cell"><input class="node-check" type="checkbox" data-node-select="${escapeHtml(node.id)}"${state.selectedNodeIds.has(node.id) ? ' checked' : ''}></td>
      <td>
        <div class="node-name">${escapeHtml(node.name)}</div>
        <div class="node-meta">${escapeHtml(node.type.toUpperCase())}</div>
      </td>
      <td>${escapeHtml(node.group || '--')}</td>
      <td>
        <div>${escapeHtml(node.server)}:${escapeHtml(node.port)}</div>
        <div class="node-meta">${escapeHtml(node.error || '')}</div>
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
    </tr>`).join('');
  updateBulkSelectionUi(data);
}

function renderSettings(data) {
  $('#settingSingBox').value = data.settings.singBoxPath || '';
  $('#settingTestUrl').value = data.settings.testUrl || '';
  $('#settingInterval').value = data.settings.testIntervalSec || 300;
  $('#settingProxyHost').value = data.settings.proxyListenHost || '';
  $('#settingHttpPort').value = data.settings.httpPort || '';
  $('#settingSocksPort').value = data.settings.socksPort || '';
  $('#coreListenInfo').textContent = `${data.settings.proxyListenHost}:${data.settings.httpPort} / SOCKS ${data.settings.socksPort}`;
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
  if (event.target.id === 'selectAllNodes') {
    state.selectedNodeIds.clear();
    if (event.target.checked) {
      for (const node of state.data?.nodes || []) state.selectedNodeIds.add(node.id);
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
  const groupActive = target.dataset.groupActive;
  const groupTest = target.dataset.groupTest;
  const groupDelete = target.dataset.groupDelete;

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
  }
});

checkSession();
setInterval(() => {
  if (!$('#appView').classList.contains('hidden')) {
    loadState().catch(() => {});
  }
}, 10000);
