'use strict';

const params = new URLSearchParams(location.search);
const reset = params.get('mode') === 'reset';
const purpose = params.get('purpose') || 'setup';
const hasLocal = params.get('hasLocal') === '1';
const title = document.getElementById('title');
const lead = document.getElementById('lead');
const submit = document.getElementById('submit');
const error = document.getElementById('error');
const form = document.getElementById('form');
const username = document.getElementById('username');
const password = document.getElementById('password');
const confirm = document.getElementById('confirm');
const serverUrl = document.getElementById('serverUrl');
const modes = document.getElementById('modes');
const localPanel = document.getElementById('localPanel');
const remotePanel = document.getElementById('remotePanel');
const localExisting = document.getElementById('localExisting');
const localFields = document.getElementById('localFields');
const DEFAULT_SERVER = 'https://quote.byberg.store';
let selectedMode = params.get('currentMode')
  || (reset ? 'local' : (purpose === 'setup' ? 'remote' : 'local'));

username.value = params.get('username') || 'admin';
serverUrl.value = params.get('serverUrl') || (purpose === 'setup' ? DEFAULT_SERVER : '');

function submitLabel() {
  if (reset) return '保存新密码并进入系统';
  if (selectedMode === 'remote') return '连接中央服务器';
  if (hasLocal && purpose === 'switch') return '使用本机模式并重启';
  return '创建本机管理员并进入系统';
}

function renderMode() {
  const useExistingLocal = hasLocal && purpose === 'switch' && !reset;
  modes.querySelectorAll('[data-mode]').forEach(button => {
    button.classList.toggle('on', button.dataset.mode === selectedMode);
  });
  localPanel.classList.toggle('on', selectedMode === 'local');
  remotePanel.classList.toggle('on', selectedMode === 'remote');
  localExisting.hidden = !useExistingLocal;
  localFields.hidden = useExistingLocal;
  submit.textContent = submitLabel();
}

if (reset) {
  selectedMode = 'local';
  document.title = '重置管理员密码';
  title.textContent = '重置管理员密码';
  lead.textContent = '本机已有管理员账户，但尚未完成明确的密码设置。请重新设置本机管理员密码。';
  modes.hidden = true;
  username.readOnly = true;
} else if (purpose === 'switch') {
  document.title = '连接设置';
  title.textContent = '连接设置';
  lead.textContent = '切换后客户端会自动重启。本机数据和服务器数据不会互相删除。';
}

modes.querySelectorAll('[data-mode]').forEach(button => {
  button.addEventListener('click', () => {
    if (reset) return;
    selectedMode = button.dataset.mode;
    error.textContent = '';
    renderMode();
  });
});
renderMode();

document.getElementById('cancel').addEventListener('click', () => window.adminSetup.cancel());

form.addEventListener('submit', async event => {
  event.preventDefault();
  error.textContent = '';
  let payload;

  if (selectedMode === 'remote') {
    if (!serverUrl.value.trim()) {
      error.textContent = '请填写中央服务器地址';
      return;
    }
    payload = {
      mode: 'remote',
      serverUrl: serverUrl.value.trim(),
    };
  } else if (hasLocal && purpose === 'switch' && !reset) {
    payload = { mode: 'local', localReady: true };
  } else {
    const accountName = username.value.trim();
    if (!/^[A-Za-z0-9_.-]{2,32}$/.test(accountName)) {
      error.textContent = '用户名只能使用字母、数字、下划线、点和横线，2–32 位';
      return;
    }
    if (password.value.length < 8) {
      error.textContent = '密码至少 8 位';
      return;
    }
    if (password.value !== confirm.value) {
      error.textContent = '两次输入的密码不一致';
      return;
    }
    payload = {
      mode: 'local',
      username: accountName,
      password: password.value,
      confirmPassword: confirm.value,
    };
  }

  submit.disabled = true;
  submit.textContent = selectedMode === 'remote' ? '正在验证服务器…' : '正在处理…';
  try {
    const result = await window.adminSetup.submit(payload);
    if (!result.ok) {
      error.textContent = result.error || '设置失败';
      submit.disabled = false;
      submit.textContent = submitLabel();
    }
  } catch (e) {
    error.textContent = e.message || '设置失败';
    submit.disabled = false;
    submit.textContent = submitLabel();
  }
});

if (selectedMode === 'remote') serverUrl.focus();
else if (localFields.hidden) submit.focus();
else password.focus();
