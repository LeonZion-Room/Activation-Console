const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
let TOKEN = localStorage.getItem('act_token') || '';
let GROUPS = [];
let logPage = 1, opPage = 1;

async function api(path, opts = {}) {
  opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (TOKEN) opts.headers['X-Token'] = TOKEN;
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({ code: r.status, msg: '响应异常' }));
  if (r.status === 401) { showLogin(); throw new Error(j.msg || '未登录'); }
  if (j.code !== 0) throw new Error(j.msg || '请求失败');
  return j.data;
}

function showLogin() {
  TOKEN = ''; localStorage.removeItem('act_token');
  $('#mainPage').classList.add('hidden');
  $('#loginPage').classList.remove('hidden');
  $('#loginPwd').focus();
}
function showMain() {
  $('#loginPage').classList.add('hidden');
  $('#mainPage').classList.remove('hidden');
  switchView('dashboard');
}

$('#loginBtn').onclick = doLogin;
$('#loginPwd').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
async function doLogin() {
  const pwd = $('#loginPwd').value;
  if (!pwd) { $('#loginErr').textContent = '请输入密码'; return; }
  try {
    const d = await api('/api/v1/login', { method: 'POST', body: JSON.stringify({ password: pwd }) });
    TOKEN = d.token; localStorage.setItem('act_token', TOKEN);
    $('#loginErr').textContent = '';
    showMain();
  } catch (e) { $('#loginErr').textContent = e.message; }
}
$('#logoutBtn').onclick = async () => { try { await api('/api/v1/logout', { method: 'POST' }); } catch (e) {} showLogin(); };

// ---------- 视图切换 ----------
$$('.nav').forEach(a => a.onclick = e => { e.preventDefault(); switchView(a.dataset.view); });
function switchView(v) {
  $$('.nav').forEach(a => a.classList.toggle('active', a.dataset.view === v));
  $$('.view').forEach(s => s.classList.add('hidden'));
  $('#view-' + v).classList.remove('hidden');
  if (v === 'dashboard') loadDash();
  if (v === 'cards') { loadGroups(); loadCards(); }
  if (v === 'logs') { logPage = 1; loadLogs(); }
  if (v === 'oplogs') { opPage = 1; loadOpLogs(); }
  if (v === 'settings') loadSettings();
}

// ---------- 看板 ----------
async function loadDash() {
  const d = await api('/api/v1/dashboard');
  $('#stTotal').textContent = d.total;
  $('#stActive').textContent = d.active;
  $('#stStopped').textContent = d.stopped;
  $('#stVerify').textContent = d.check_24h;
  $('#stGroups').textContent = d.groups;
  $('#recentVerify').innerHTML = (d.recent || []).map(r => `
    <tr><td>${r.project_code}</td><td>${r.client_ip}</td>
    <td class="${r.result ? 'ok-t' : 'bad-t'}">${r.result ? '通过' : '拒绝'}</td>
    <td>${r.message}</td><td>${r.created_at}</td></tr>`).join('')
    || '<tr><td colspan="5" style="color:#7d8aa6">暂无记录</td></tr>';
}

// ---------- 分组 ----------
async function loadGroups() {
  GROUPS = await api('/api/v1/group/list');
  if (GROUPS.length === 0) return;
  $('#groupFilter').innerHTML = '<option value="0">全部分组</option>' +
    GROUPS.map(g => `<option value="${g.id}">${g.name}(${g.project_count})</option>`).join('');
}
$('#groupFilter').onchange = loadCards;
let searchTimer;
$('#searchBox').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadCards, 300); });

$('#groupMgrBtn').onclick = () => {
  openModal('分组管理', `
    <div id="gList">${GROUPS.map(g => `
      <div class="form-row" data-gid="${g.id}">
        <label>${g.name}</label>
        <input value="${g.name}" data-f="name">
        <input value="${g.remark || ''}" data-f="remark" placeholder="备注">
        <button class="btn sm" data-act="save">保存</button>
        <button class="btn sm danger" data-act="del">删除</button>
      </div>`).join('')}</div>
    <div class="form-row" style="margin-top:12px">
      <input id="newGName" placeholder="新分组名称">
      <button class="btn" id="addG">+ 添加分组</button>
    </div>`, null, async () => {
    $('#addG').onclick = async () => {
      const n = $('#newGName').value.trim(); if (!n) return;
      await api('/api/v1/group/add', { method: 'POST', body: JSON.stringify({ name: n }) });
      closeModal(); await loadGroups(); loadCards(); $('#groupMgrBtn').click();
    };
    $('#gList').onclick = async e => {
      const btn = e.target.closest('button'); if (!btn) return;
      const row = btn.closest('.form-row'); const gid = row.dataset.gid;
      const name = row.querySelector('[data-f=name]').value;
      const remark = row.querySelector('[data-f=remark]').value;
      try {
        if (btn.dataset.act === 'save')
          await api('/api/v1/group/update/' + gid, { method: 'PUT', body: JSON.stringify({ name, remark }) });
        else
          await api('/api/v1/group/delete/' + gid, { method: 'DELETE' });
        await loadGroups(); loadCards(); closeModal(); $('#groupMgrBtn').click();
      } catch (e2) { alert(e2.message); }
    };
  });
};

// ---------- 项目卡片 ----------
async function loadCards() {
  const gid = $('#groupFilter').value;
  const q = $('#searchBox').value.trim();
  const list = await api(`/api/v1/project/list?group_id=${gid}&q=${encodeURIComponent(q)}`);
  $('#cardGrid').innerHTML = list.map(c => `
    <div class="card ${c.is_activate ? '' : 'off'}" data-id="${c.id}">
      <div class="card-top">
        <div>
          <div class="card-title">${esc(c.name)}</div>
          <div class="card-code">${esc(c.project_code)}</div>
        </div>
        <span class="badge ${c.is_activate ? 'on' : 'off'}">${c.is_activate ? '已激活' : '已停用'}</span>
      </div>
      <div class="card-desc">${esc(c.description || '—')}</div>
      <div class="card-meta">
        分组：${esc(c.group_name || '未分组')}<br>
        状态：<span class="badge ${c.status === 'running' ? 'on' : 'gray'}">${c.status === 'running' ? '运行中' : '已停止'}</span>
        ${c.last_check_at ? `<br>最近校验：${c.last_check_at}（${c.last_status || ''}）${c.client_ip ? ' · ' + c.client_ip : ''}` : '<br>最近校验：暂无'}
      </div>
      <div class="card-actions">
        <button class="btn sm ${c.is_activate ? 'danger' : 'primary'}" data-act="toggle">${c.is_activate ? '停用' : '激活'}</button>
        <button class="btn sm ghost" data-act="del">删除</button>
      </div>
    </div>`).join('') || '<div style="color:#7d8aa6">暂无项目</div>';
}

$('#cardGrid').onclick = async e => {
  const btn = e.target.closest('button'); if (!btn) return;
  const id = btn.closest('.card').dataset.id;
  try {
    if (btn.dataset.act === 'toggle') {
      const card = await api(`/api/v1/project/list`);
      const target = card.find(c => String(c.id) === id);
      await api('/api/v1/project/status', { method: 'PUT', body: JSON.stringify({ id: +id, is_activate: !target.is_activate }) });
      loadCards();
    } else if (btn.dataset.act === 'del') {
      if (!confirm('确认删除该项目？')) return;
      await api('/api/v1/project/delete/' + id, { method: 'DELETE' });
      loadCards();
    }
  } catch (err) { alert(err.message); }
};

$('#newCardBtn').onclick = () => projectForm('新建项目', {}, async body => {
  await api('/api/v1/project/add', { method: 'POST', body: JSON.stringify(body) });
  closeModal(); loadCards();
});

function projectForm(title, p, onSave) {
  const opts = ['<option value="0">未分组</option>'].concat(
    GROUPS.map(g => `<option value="${g.id}">${g.name}</option>`)).join('');
  openModal(title, `
    <div class="form-row"><label>项目编码</label><input id="f_code" placeholder="如 svc-backup"></div>
    <div class="form-row"><label>项目名称</label><input id="f_name"></div>
    <div class="form-row"><label>所属分组</label><select id="f_group">${opts}</select></div>
    <div class="form-row"><label>描述</label><textarea id="f_desc"></textarea></div>
    <div class="form-row"><label>激活状态</label>
      <select id="f_act"><option value="1" selected>已激活（允许运行）</option>
      <option value="0">已停用（心跳即关停）</option></select></div>`,
    async () => {
      const body = {
        project_code: $('#f_code').value.trim(),
        name: $('#f_name').value.trim(),
        group_id: +$('#f_group').value,
        description: $('#f_desc').value.trim(),
        is_activate: $('#f_act').value === '1',
      };
      if (!body.project_code || !body.name) { alert('编码与名称必填'); return; }
      await onSave(body);
    });
}

// 批量
$('#batchOn').onclick = () => batch('activate');
$('#batchOff').onclick = () => batch('deactivate');
async function batch(action) {
  const ids = [...$$('#cardGrid .card')].map(el => +el.dataset.id);
  if (!ids.length) return alert('无项目');
  if (!confirm(`确认${action === 'activate' ? '激活' : '停用'}全部 ${ids.length} 个项目？`)) return;
  await api('/api/v1/project/batch', { method: 'POST', body: JSON.stringify({ action, ids }) });
  loadCards();
}

// ---------- 校验日志 ----------
$('#logSearch').onclick = () => { logPage = 1; loadLogs(); };
$('#logPrev').onclick = () => { if (logPage > 1) { logPage--; loadLogs(); } };
$('#logNext').onclick = () => { logPage++; loadLogs(); };
async function loadLogs() {
  const code = $('#logCode').value.trim();
  const d = await api(`/api/v1/log/check?page=${logPage}&size=20&project_code=${encodeURIComponent(code)}`);
  const pages = Math.max(1, Math.ceil(d.total / d.size));
  if (logPage > pages) { logPage = pages; return loadLogs(); }
  $('#logPageInfo').textContent = `${logPage} / ${pages}（共${d.total}条）`;
  $('#logBody').innerHTML = d.items.map(r => `
    <tr><td>${r.id}</td><td>${esc(r.project_code)}</td><td>${r.client_ip}</td>
    <td class="${r.result ? 'ok-t' : 'bad-t'}">${r.result ? '通过' : '拒绝'}</td>
    <td>${esc(r.message)}</td><td>${r.created_at}</td></tr>`).join('')
    || '<tr><td colspan="6" style="color:#7d8aa6">暂无记录</td></tr>';
}
$('#opPrev').onclick = () => { if (opPage > 1) { opPage--; loadOpLogs(); } };
$('#opNext').onclick = () => { opPage++; loadOpLogs(); };
async function loadOpLogs() {
  const d = await api(`/api/v1/log/operate?page=${opPage}&size=20`);
  const pages = Math.max(1, Math.ceil(d.total / d.size));
  if (opPage > pages) { opPage = pages; return loadOpLogs(); }
  $('#opPageInfo').textContent = `${opPage} / ${pages}（共${d.total}条）`;
  $('#opBody').innerHTML = d.items.map(r => `
    <tr><td>${r.id}</td><td>${r.operator}</td><td>${esc(r.action)}</td>
    <td>${esc(r.detail)}</td><td>${r.client_ip}</td><td>${r.created_at}</td></tr>`).join('')
    || '<tr><td colspan="6" style="color:#7d8aa6">暂无记录</td></tr>';
}

// ---------- 设置 ----------
async function loadSettings() {
  const d = await api('/api/v1/settings');
  $('#apiKeyText').textContent = d.auth_key;
  const host = location.host;
  $('#sdkDemo').textContent =
`import time, requests

API = "http://${host}"
AUTH_KEY = "${d.auth_key}"
PROJECT_CODE = "svc-backup"   # 你在卡片中登记的编码

def check() -> bool:
    """每日心跳：True=允许运行；False/超时=立即关停服务"""
    try:
        r = requests.get(f"{API}/api/v1/project/check",
                         params={"project_code": PROJECT_CODE},
                         headers={"X-Auth-Key": AUTH_KEY},
                         timeout=10)
        return r.json()["data"]["is_activate"] is True
    except Exception:
        return False   # 超时/异常一律按不可激活处理，关停服务

if __name__ == "__main__":
    if check():
        print("激活通过，服务保活运行")
    else:
        print("未通过校验，立即关停服务")
        # os._exit(1)  # 实际部署时终止你的常驻进程`;
}
$('#changePwdBtn').onclick = () => {
  openModal('修改管理密码', `
    <div class="form-row"><label>原密码</label><input type="password" id="p_old"></div>
    <div class="form-row"><label>新密码</label><input type="password" id="p_new"></div>`,
    async () => {
      await api('/api/v1/settings', { method: 'PUT', body: JSON.stringify({
        old_password: $('#p_old').value, new_password: $('#p_new').value }) });
      closeModal(); alert('密码已修改');
    });
};
$('#rotateKeyBtn').onclick = () => {
  if (!confirm('轮换后旧密钥立即失效，所有客户端需更新，确认？')) return;
  api('/api/v1/settings', { method: 'PUT', body: JSON.stringify({ rotate_auth_key: true }) })
    .then(() => { loadSettings(); alert('密钥已轮换'); });
};

// ---------- 弹层工具 ----------
function openModal(title, html, onOk) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = html;
  $('#modal').classList.remove('hidden');
  $('#modalOk').onclick = onOk || closeModal;
}
function closeModal() { $('#modal').classList.add('hidden'); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

// ---------- 启动 ----------
(async function init() {
  if (!TOKEN) return showLogin();
  try { await fetch('/api/v1/dashboard', { headers: { 'X-Token': TOKEN } }); showMain(); }
  catch (e) { showLogin(); }
})();