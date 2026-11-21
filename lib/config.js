'use strict';
/**
 * 运行时密钥配置
 *
 * 安全约束：
 *  - Key 只保存在服务端（环境变量 或 data/config.json，后者已 .gitignore）
 *  - 任何接口都不会把完整 Key 返回给前端，只返回是否已配置 + 掩码
 *  - 不写入日志
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.ZHIXUAN_DATA_DIR || path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

let fileConfig = {};
try {
  if (fs.existsSync(CONFIG_FILE)) fileConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8') || '{}');
} catch { fileConfig = {}; }

function get() {
  return {
    fuyaoApiKey: process.env.FUYAO_API_KEY || fileConfig.fuyaoApiKey || '',
    dashscopeApiKey: process.env.DASHSCOPE_API_KEY || fileConfig.dashscopeApiKey || '',
    qwenModel: process.env.QWEN_MODEL || fileConfig.qwenModel || 'qwen-plus',
    envLocked: {
      fuyao: !!process.env.FUYAO_API_KEY,
      dashscope: !!process.env.DASHSCOPE_API_KEY,
    },
  };
}

function save(patch) {
  const next = { ...fileConfig };
  for (const k of ['fuyaoApiKey', 'dashscopeApiKey', 'qwenModel']) {
    if (typeof patch[k] === 'string') {
      if (patch[k] === '') delete next[k];
      else next[k] = patch[k];
    }
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  fileConfig = next;
  return get();
}

function mask(v) {
  if (!v) return null;
  if (v.length <= 8) return '****';
  return `${v.slice(0, 4)}****${v.slice(-4)}`;
}

/** 对外暴露的状态（不含明文） */
function publicStatus() {
  const c = get();
  return {
    fuyao: { configured: !!c.fuyaoApiKey, masked: mask(c.fuyaoApiKey), source: c.envLocked.fuyao ? 'env' : (c.fuyaoApiKey ? 'runtime' : 'none') },
    dashscope: { configured: !!c.dashscopeApiKey, masked: mask(c.dashscopeApiKey), source: c.envLocked.dashscope ? 'env' : (c.dashscopeApiKey ? 'runtime' : 'none') },
    qwenModel: c.qwenModel,
  };
}

module.exports = { get, save, publicStatus, mask, CONFIG_FILE };
