/* OpenRouter 免费模型广场 —— 纯前端，无构建、无后端 */
(() => {
'use strict';

const API = 'https://openrouter.ai/api/v1';
const K = {
  key: 'orf.apiKey', settings: 'orf.settings', picks: 'orf.picks',
  turns: 'orf.turns', cache: 'orf.modelCache', seen: 'orf.sawSettings'
};
const MAX_PICKS = 4;
const CACHE_TTL = 30 * 60 * 1000;
const FREE_MIN_PER_MIN = 20;

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} }
};

/* ================= 状态 ================= */
const state = {
  models: [], totalScanned: 0, source: 'loading', fetchedAt: null,
  q: '', sort: 'created:desc', family: '', flags: new Set(),
  picks: ls.get(K.picks, []),
  turns: ls.get(K.turns, []),
  notes: [],
  running: false, aborts: [], reqTimes: [], dirty: new Set(), raf: 0
};
let settings = Object.assign({ system: '', temp: '', maxtok: '', stream: true }, ls.get(K.settings, {}));
let apiKey = ls.get(K.key, '');

/* ================= 工具 ================= */
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtNum = n => n >= 1e6 ? (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + 'M' : n >= 1000 ? (n / 1000).toFixed(n % 1000 ? 1 : 0) + 'K' : String(n ?? 0);
const fmtDate = ts => new Date(ts * 1000).toLocaleDateString('zh-CN');
const toastEl = $('#toast');
let toastT;
function toast(msg, ms = 2400) {
  toastEl.hidden = false; toastEl.textContent = msg;
  clearTimeout(toastT); toastT = setTimeout(() => toastEl.hidden = true, ms);
}
async function copy(text, label = '已复制') {
  try { await navigator.clipboard.writeText(text); toast(label); }
  catch { const t = document.createElement('textarea'); t.value = text; document.body.append(t); t.select(); document.execCommand('copy'); t.remove(); toast(label); }
}

/* ================= Markdown（最小实现，全程转义防注入） ================= */
function mdInline(t) {
  return String(t).split(/(`[^`\n]+`)/).map(p => {
    if (p.startsWith('`') && p.length > 2 && p.endsWith('`')) return '<code>' + esc(p.slice(1, -1)) + '</code>';
    let s = esc(p);
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/__([^_]+)__/g, '<b>$1</b>');
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<i>$2</i>');
    s = s.replace(/~~([^~]+)~~/g, '<s>$1</s>');
    return s;
  }).join('');
}
function preCode(code, lang) {
  return '<pre><button class="copy-code" type="button">复制</button>' +
    '<code' + (lang ? ' data-lang="' + esc(lang) + '"' : '') + '>' + esc(code) + '</code></pre>';
}
function md(src) {
  const lines = String(src ?? '').replace(/\r/g, '').split('\n');
  const out = []; let i = 0, para = [];
  const flush = () => { if (para.length) { out.push('<p>' + mdInline(para.join('\n')).replace(/\n/g, '<br>') + '</p>'); para = []; } };
  while (i < lines.length) {
    const L = lines[i];
    const f = L.match(/^\s*(```+|~~~+)\s*([\w.+#-]*)\s*$/);
    if (f) {
      flush(); const mark = f[1][0], buf = []; i++;
      while (i < lines.length && !new RegExp('^\\s*' + mark + '{' + f[1].length + '}\\s*$').test(lines[i])) buf.push(lines[i++]);
      i++; out.push(preCode(buf.join('\n'), f[2])); continue;
    }
    if (!L.trim()) { flush(); i++; continue; }
    const h = L.match(/^\s*(#{1,6})\s+(.*)$/);
    if (h) { flush(); const n = Math.min(h[1].length, 3); out.push(`<h${n}>${mdInline(h[2])}</h${n}>`); i++; continue; }
    if (/^\s*([-*_])\s*(?:\1\s*){2,}$/.test(L)) { flush(); out.push('<hr>'); i++; continue; }
    if (/^\s*>/.test(L)) {
      flush(); const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push('<blockquote>' + mdInline(buf.join(' ')) + '</blockquote>'); continue;
    }
    if (L.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]*-[\s:|-]*\|[\s:|-]*$/.test(lines[i + 1])) {
      flush();
      const cells = r => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
      const head = cells(L); i += 2;
      const body = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) body.push(cells(lines[i++]));
      out.push('<table><thead><tr>' + head.map(c => '<th>' + mdInline(c) + '</th>').join('') + '</tr></thead><tbody>' +
        body.map(r => '<tr>' + r.map(c => '<td>' + mdInline(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table>');
      continue;
    }
    if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(L)) {
      flush();
      const ord = /^\s*\d+[.)]/.test(L), items = [];
      while (i < lines.length && /^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[i])) {
        items.push(lines[i++].replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ''));
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[i])) items[items.length - 1] += ' ' + lines[i++].trim();
      }
      const tag = ord ? 'ol' : 'ul';
      out.push(`<${tag}>` + items.map(t => '<li>' + mdInline(t) + '</li>').join('') + `</${tag}>`);
      continue;
    }
    para.push(L); i++;
  }
  flush();
  return out.join('');
}
document.addEventListener('click', e => {
  const b = e.target.closest('.copy-code');
  if (b) copy(b.parentElement.querySelector('code').textContent, '代码已复制');
});

/* ================= 模型数据 ================= */
function normalize(m) {
  const sp = m.supported_parameters || [];
  const arch = m.architecture || {};
  const inMod = arch.input_modalities || [], outMod = arch.output_modalities || [];
  const id = m.id || '';
  const slug = m.canonical_slug || id.replace(/:free$/, '');
  return {
    id, slug, name: m.name || id,
    family: (slug.split('/')[0] || id).replace(/\//g, ''),
    creator: (m.name || '').split(':')[0].trim() || slug.split('/')[0] || '?',
    desc: m.description || '',
    ctx: m.context_length || 0,
    maxOut: m.top_provider?.max_completion_tokens || 0,
    created: m.created || 0,
    tokenizer: arch.tokenizer || '',
    modality: arch.modality || 'text->text',
    freeSuffix: /:free$/i.test(id),
    tools: sp.includes('tools'),
    reasoning: sp.includes('reasoning') || sp.includes('include_reasoning'),
    structured: sp.includes('structured_outputs') || sp.includes('response_format'),
    vision: inMod.includes('image'),
    video: inMod.includes('video'),
    audioIn: inMod.includes('audio'),
    audioOut: outMod.includes('audio'),
    imageOut: outMod.includes('image'),
    params: sp,
    pricePrompt: Number(m.pricing?.prompt || 0),
    priceCompletion: Number(m.pricing?.completion || 0)
  };
}
const isFree = m => m.pricePrompt === 0 && m.priceCompletion === 0;

async function loadModels({ force = false } = {}) {
  const cached = ls.get(K.cache, null);
  if (!force && cached && Date.now() - cached.at < CACHE_TTL) {
    applyModels(cached.models, cached.total, 'cache', cached.at); return;
  }
  try {
    const r = await fetch(`${API}/models`, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const all = (await r.json())?.data || [];
    const free = all.filter(m => isFree(normalize(m))).map(normalize);
    ls.set(K.cache, { at: Date.now(), models: free, total: all.length });
    applyModels(free, all.length, 'live', Date.now());
  } catch (err) {
    if (cached) applyModels(cached.models, cached.total, 'cache', cached.at);
    else if (window.FALLBACK_FREE_MODELS?.length) applyModels((window.FALLBACK_FREE_MODELS).map(normalize), window.FALLBACK_FREE_MODELS.length, 'fallback', null);
    else { $('#data-source').textContent = '加载失败'; $('#model-list').innerHTML = `<div class="hint-empty">拉取模型列表失败：${esc(err.message)}<br>检查网络后点右上「刷新列表」</div>`; }
    toast('在线拉取失败，使用本地数据兜底');
  }
}
function applyModels(models, total, source, at) {
  state.models = models; state.totalScanned = total || models.length;
  state.source = source; state.fetchedAt = at;
  state.picks = state.picks.filter(id => models.some(m => m.id === id));
  renderAll();
}
function byId(id) { return state.models.find(m => m.id === id); }
function visibleModels() {
  const q = state.q.trim().toLowerCase();
  return state.models.filter(m => {
    if (state.family && m.family !== state.family) return false;
    for (const f of state.flags) {
      if (f === 'bigctx' ? m.ctx < 131072 : !m[f]) return false;
    }
    if (q && !(m.name + ' ' + m.id + ' ' + m.desc + ' ' + m.creator).toLowerCase().includes(q)) return false;
    return true;
  }).sort((a, b) => {
    switch (state.sort) {
      case 'created:asc': return a.created - b.created;
      case 'context:desc': return b.ctx - a.ctx;
      case 'name:asc': return a.name.localeCompare(b.name);
      default: return b.created - a.created;
    }
  });
}

/* ================= 渲染：模型库 ================= */
function flagTags(m) {
  const t = [];
  if (m.vision) t.push(['b', '视觉']);
  if (m.video) t.push(['b', '视频']);
  if (m.audioIn) t.push(['b', '音频入']);
  if (m.audioOut || m.imageOut) t.push(['b', '多模态输出']);
  if (m.tools) t.push(['g', '工具']);
  if (m.reasoning) t.push(['y', '推理']);
  if (m.structured) t.push(['', '结构化']);
  return t;
}
function renderStats() {
  const ms = state.models;
  const max = ms.reduce((a, m) => Math.max(a, m.ctx), 0);
  $('#stats').innerHTML = [
    [`<b>${ms.length}</b>`, `免费 / 共 ${state.totalScanned}`],
    [`<b>${ms.filter(m => m.tools).length}</b>`, '支持工具调用'],
    [`<b>${ms.filter(m => m.reasoning).length}</b>`, '支持推理'],
    [`<b>${fmtNum(max)}</b>`, '最长上下文']
  ].map(([v, k]) => `<div class="stat">${v}<span>${k}</span></div>`).join('');

  const fams = {}; ms.forEach(m => fams[m.family] = (fams[m.family] || 0) + 1);
  const sel = $('#family'), cur = state.family;
  sel.innerHTML = `<option value="">全部厂商 (${ms.length})</option>` +
    Object.entries(fams).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([f, n]) => `<option value="${esc(f)}">${esc(f)} (${n})</option>`).join('');
  sel.value = fams[cur] ? cur : (state.family = '');
}
function renderList() {
  const box = $('#model-list');
  if (!state.models.length) {
    box.innerHTML = state.source === 'loading'
      ? '<div class="hint-empty">正在拉取 OpenRouter 模型列表…</div>' : '<div class="hint-empty">没有免费模型</div>';
    return;
  }
  const list = visibleModels();
  if (!list.length) { box.innerHTML = `<div class="hint-empty">没有符合条件的免费模型<br><button class="btn sm ghost" id="reset-f">清空筛选条件</button></div>`; $('#reset-f')?.addEventListener('click', resetFilters); return; }
  box.innerHTML = list.map(m => {
    const on = state.picks.includes(m.id);
    return `<div class="mcard${on ? ' picked' : ''}" data-id="${esc(m.id)}">
      <div class="mcard-top"><div class="mname">${esc(m.name)}${on ? ' <span class="on">✓</span>' : ''}</div>
        <div class="tag g">${fmtNum(m.ctx)}</div></div>
      <div class="mid">${esc(m.id)}</div>
      ${m.desc ? `<p class="mdesc">${esc(m.desc)}</p>` : ''}
      <div class="mtags">${flagTags(m).map(([c, t]) => `<span class="tag ${c}">${t}</span>`).join('')}
        <span class="tag">${fmtDate(m.created)}</span></div>
      <div class="mcard-acts">
        <button class="btn sm ${on ? 'danger' : 'primary'}" data-act="pick">${on ? '－ 移出' : '＋ 对话'}</button>
        <button class="btn sm ghost" data-act="detail">详情</button>
        <button class="btn sm ghost" data-act="copy">复制 ID</button>
        <a class="btn sm ghost" href="https://openrouter.ai/${esc(m.slug)}" target="_blank" rel="noreferrer">主页 ↗</a>
      </div></div>`;
  }).join('');
}
function resetFilters() {
  state.q = ''; state.flags = new Set(); state.family = ''; state.sort = 'created:desc';
  $('#q').value = ''; $('#sort').value = state.sort;
  $$('#flag-chips input').forEach(i => i.checked = false);
  renderAll();
}
$('#model-list').addEventListener('click', e => {
  const card = e.target.closest('.mcard'); if (!card) return;
  const id = card.dataset.id, m = byId(id);
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'pick') togglePick(id);
  else if (act === 'copy') copy(id, '模型 ID 已复制：' + id);
  else if (act === 'detail') showDetail(m);
});

/* ================= 详情 ================= */
function showDetail(m) {
  $('#detail-body').innerHTML = `
    <h2>${esc(m.name)}</h2>
    <div class="mid">${esc(m.id)}</div>
    <dl class="kv">
      <dt>免费标识</dt><dd>${m.freeSuffix ? 'ID 带 :free 后缀' : '无 :free 后缀，但定价为 $0'}</dd>
      <dt>上下文</dt><dd>${(m.ctx || 0).toLocaleString()} tokens</dd>
      <dt>最大输出</dt><dd>${m.maxOut ? m.maxOut.toLocaleString() + ' tokens' : '未公布'}</dd>
      <dt>模态</dt><dd>${esc(m.modality)}</dd>
      <dt>分词器</dt><dd>${esc(m.tokenizer || '-')}</dd>
      <dt>上架时间</dt><dd>${fmtDate(m.created)}</dd>
      <dt>价格</dt><dd>prompt $${m.pricePrompt} / completion $${m.priceCompletion}（每 token）</dd>
    </dl>
    <div class="detail-sec"><b style="font-size:13px">支持的请求参数</b>
      <div class="mtags" style="margin-top:8px">${m.params.map(p => `<span class="tag">${esc(p)}</span>`).join('') || '<span class="muted">未公布</span>'}</div></div>
    <div class="detail-sec"><b style="font-size:13px">描述</b>
      <div class="md" style="font-size:13px;margin-top:6px">${md(m.desc)}</div></div>
    ${(m.audioOut || m.imageOut) ? `<p class="muted" style="font-size:12.5px">⚠ 该模型输出含音频/图片，本站的文本对话框可能拿不到文字回复。</p>` : ''}
    ${m.id === 'openrouter/free' ? `<p class="muted" style="font-size:12.5px">ℹ 这是 OpenRouter 的免费路由器：由它替你挑选当前可用的 $0 模型。</p>` : ''}
    <div class="modal-actions">
      <a class="btn ghost" href="https://openrouter.ai/${esc(m.slug)}" target="_blank" rel="noreferrer">在 OpenRouter 打开 ↗</a>
      <button class="btn primary" id="d-pick">${state.picks.includes(m.id) ? '移出对话' : '加入对话'}</button>
    </div>`;
  openModal('#detail-modal');
  $('#d-pick').onclick = () => { togglePick(m.id); closeModal('#detail-modal'); };
}

/* ================= 对话：选择模型 ================= */
function togglePick(id) {
  const i = state.picks.indexOf(id);
  if (i >= 0) state.picks.splice(i, 1);
  else {
    if (state.picks.length >= MAX_PICKS) return toast(`最多同时对比 ${MAX_PICKS} 个模型`);
    state.picks.push(id);
  }
  ls.set(K.picks, state.picks); renderAll();
}
function renderPicks() {
  const box = $('#picks');
  if (!state.picks.length) { box.innerHTML = '<span class="muted">尚未选择模型 —— 点左侧卡片「＋对话」即可加入，可多选做同题对比</span>'; return; }
  box.innerHTML = state.picks.map(id => {
    const m = byId(id);
    return `<span class="pick" title="${esc(id)}"><span>${esc(m ? m.name : id)}</span><button data-rm="${esc(id)}" title="移出">×</button></span>`;
  }).join('');
}
$('#picks').addEventListener('click', e => {
  const id = e.target.closest('[data-rm]')?.dataset.rm;
  if (id) togglePick(id);
});

/* ================= OpenRouter 调用 ================= */
function chatHeaders() {
  return {
    Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json',
    'X-Title': 'OpenRouter Free Hub'
  };
}
function bodyFor(id, messages) {
  const b = { model: id, messages, usage: { include: true } };
  if (settings.stream) b.stream = true;
  const t = parseFloat(settings.temp); if (Number.isFinite(t)) b.temperature = t;
  const mt = parseInt(settings.maxtok, 10); if (mt > 0) b.max_tokens = mt;
  return b;
}
async function httpError(res) {
  let detail = '';
  try { const j = await res.json(); detail = j?.error?.message || j?.message || JSON.stringify(j).slice(0, 300); }
  catch { try { detail = (await res.text()).slice(0, 300); } catch {} }
  const hint = res.status === 429 ? '（免费模型限速：20 次/分钟；余额不足 $10 时每天仅 50 次）'
    : res.status === 401 ? '（Key 无效或未填）' : res.status === 402 ? '（额度耗尽）' : '';
  return new Error(`${res.status} ${res.statusText} ${hint}\n${detail}`.trim());
}
function historyFor(id) {
  const out = [];
  const sys = (settings.system || '').trim(); if (sys) out.push({ role: 'system', content: sys });
  for (const t of state.turns) {
    if (t.q) out.push({ role: 'user', content: t.q });
    const a = t.answers?.[id];
    if (a && a.status === 'done' && a.answer) out.push({ role: 'assistant', content: a.answer });
  }
  return out;
}
/** 从 SSE 缓冲区切出完整 data 帧；OpenRouter 的 ": OPENROUTER PROCESSING" 心跳在此丢弃 */
function drainSSE(buf, onData) {
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line || line.startsWith(':')) continue;
    if (!line.startsWith('data:')) continue;
    onData(line.slice(5).trim());
  }
  return buf;
}
async function chat({ modelId, signal, onDelta, onReasoning }) {
  bump();
  const res = await fetch(`${API}/chat/completions`, {
    method: 'POST', headers: chatHeaders(), body: JSON.stringify(bodyFor(modelId, historyFor(modelId))), signal
  });
  if (!res.ok) throw await httpError(res);

  if (!settings.stream) {
    const j = await res.json();
    const msg = j?.choices?.[0]?.message || {};
    if (msg.reasoning && onReasoning) onReasoning(msg.reasoning);
    if (msg.content && onDelta) onDelta(msg.content);
    return { content: msg.content || '', usage: j.usage || null };
  }

  const rd = res.body.getReader(), dec = new TextDecoder();
  let buf = '', content = '', usage = null, streamErr = null;
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    buf = drainSSE(buf, p => {
      if (p === '[DONE]') return;
      let j; try { j = JSON.parse(p); } catch { return; }
      if (j.error) streamErr = new Error(j.error.message || '流式返回错误');
      if (j.usage) usage = j.usage;
      const d = j.choices?.[0]?.delta; if (!d) return;
      if (d.reasoning && onReasoning) onReasoning(d.reasoning);
      if (d.content) { content += d.content; onDelta && onDelta(d.content); }
    });
    if (streamErr) throw streamErr;
  }
  return { content, usage };
}

/* ================= 对话：发送 ================= */
function usedThisMinute() {
  const now = Date.now();
  state.reqTimes = state.reqTimes.filter(t => now - t < 60000);
  return state.reqTimes.length;
}
function bump() { state.reqTimes.push(Date.now()); renderQuota(); }
function renderQuota() {
  const n = usedThisMinute(), el = $('#quota-line');
  el.textContent = `本分钟已发 ${n} / ${FREE_MIN_PER_MIN}（仅统计本页请求）`;
  el.className = n >= FREE_MIN_PER_MIN ? 'hot' : n >= FREE_MIN_PER_MIN * .7 ? 'warm' : '';
  el.title = '免费模型限速 20 次/分钟；其他标签页或别的应用用同一个 Key 发的请求不计入';
}
async function send() {
  const text = $('#input').value.trim();
  if (!text || state.running) return;
  if (!apiKey) { openSettings(); return toast('请先填写 OpenRouter API Key'); }
  if (!state.picks.length) return toast('先在左侧选择至少一个免费模型');
  if (usedThisMinute() >= FREE_MIN_PER_MIN) return toast('已达免费模型限速（20 次/分钟），等一分钟再试');

  const turn = { q: text, answers: {}, t: Date.now() };
  state.picks.forEach(id => turn.answers[id] = { status: 'queued', answer: '', reasoning: '' });
  state.turns.push(turn); saveTurns();
  $('#input').value = ''; autoGrow();
  await runTurn(turn);
}
async function runTurn(turn) {
  const ids = Object.keys(turn.answers);
  ids.forEach(id => turn.answers[id].status = 'live');
  state.running = true; state.aborts = [];
  renderAll();
  const t0 = performance.now();
  await Promise.all(ids.map(async id => {
    const a = turn.answers[id]; const ac = new AbortController();
    state.aborts.push(ac);
    const mark = () => { a.ms = Math.round(performance.now() - t0); markDirty(id); };
    try {
      const r = await chat({
        modelId: id, signal: ac.signal,
        onDelta: c => { a.answer += c; if (!a.ttft) a.ttft = Math.round(performance.now() - t0); mark(); },
        onReasoning: c => { a.reasoning += c; mark(); }
      });
      a.answer = r.content || a.answer;
      a.status = ac.signal.aborted ? 'stopped' : 'done';
      a.in = r.usage?.prompt_tokens; a.out = r.usage?.completion_tokens;
    } catch (err) {
      if (err.name === 'AbortError') a.status = 'stopped';
      else { a.status = 'error'; a.error = err.message; }
    }
    a.ms = Math.round(performance.now() - t0); markDirty(id);
  }));
  state.running = false; state.aborts = [];
  saveTurns(); renderAll();
}
const markDirty = id => { state.dirty.add(id); if (!state.raf) state.raf = requestAnimationFrame(paint); };
function paint() {
  state.raf = 0;
  const th = $('.thread'); const stick = th && nearBottom(th);
  for (const id of state.dirty) {
    const boxes = $$('.ans-b[data-model="' + cssq(id) + '"]');
    const a = currentAnswer(id);
    if (!boxes.length || !a) continue;
    const last = boxes[boxes.length - 1];                    // 同一模型跨轮次时只画最新一轮
    last.innerHTML = answerBody(a);
    const card = last.closest('.ans');
    if (card) {
      const dot = $('.dot', card), meta = $('.ans-meta', card);
      if (dot) dot.className = 'dot ' + (a.status === 'live' || a.status === 'queued' ? 'live' : a.status === 'error' ? 'err' : 'done');
      if (meta) meta.textContent = ansMeta(a, byId(id));
    }
  }
  state.dirty.clear();
  if (stick) th.scrollTop = th.scrollHeight;
}
const currentAnswer = id => { for (let i = state.turns.length - 1; i >= 0; i--) if (state.turns[i].answers?.[id]) return state.turns[i].answers[id]; return null; };
const cssq = s => (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&');
const nearBottom = el => el.scrollHeight - el.scrollTop - el.clientHeight < 220;
const saveTurns = () => ls.set(K.turns, state.turns.slice(-40));

function answerBody(a) {
  if (a.status === 'error') return `<div class="err">${esc(a.error || '请求失败')}</div>` + (a.answer ? md(a.answer) : '');
  if (!a.answer && !a.reasoning) return a.status === 'stopped' ? '<span class="muted">已停止，无输出</span>' : '<span class="muted">等待首个 token…</span>';
  let h = '';
  if (a.reasoning) h += `<details class="think"${a.status === 'live' ? ' open' : ''}><summary>推理过程（${a.reasoning.length} 字）</summary>${esc(a.reasoning)}</details>`;
  h += `<div class="md">${md(a.answer)}${a.status === 'live' ? '<span class="caret"></span>' : ''}</div>`;
  return h;
}
function ansMeta(a, m) {
  const parts = [];
  if (a.ttft) parts.push('首字 ' + (a.ttft / 1000).toFixed(1) + 's');
  const out = a.out || (a.status === 'live' || a.status === 'stopped' ? Math.round((a.answer || '').length / 3.6) : 0);
  const approx = !a.out && out;
  if (out && a.ms) parts.push((approx ? '~' : '') + (out / Math.max(a.ms / 1000, .1)).toFixed(1) + ' t/s');
  if (a.ms) parts.push((a.ms / 1000).toFixed(1) + 's');
  if (out) parts.push((approx ? '~' : '') + out + ' 出词');
  if (a.in) parts.push(a.in + ' 上文');
  if (!m) parts.push('当前不在免费列表');
  return parts.join(' · ');
}
function renderThread() {
  const th = $('#thread'); const keep = nearBottom(th);
  if (!state.turns.length && !state.notes.length) { th.innerHTML = $('#thread').dataset.empty || ''; return; }
  let h = '';
  for (const t of state.turns) {
    h += `<div class="msg-user">${esc(t.q)}</div>`;
    const ids = Object.keys(t.answers);
    const cols = Math.min(ids.length, 2);
    h += `<div class="turn-q">→ ${ids.length} 个免费模型并行作答：${ids.map(i => esc(byId(i)?.name || i)).join(' | ')}</div>`;
    h += `<div class="answers" style="grid-template-columns:repeat(${cols},minmax(0,1fr))">`;
    for (const id of ids) {
      const a = t.answers[id], m = byId(id), s = a.status;
      const dot = s === 'live' || s === 'queued' ? 'live' : s === 'error' ? 'err' : 'done';
      h += `<div class="ans"><div class="ans-h"><span class="dot ${dot}"></span>
        <span class="nm" title="${esc(id)}">${esc(m ? m.name : id)}</span>
        <span class="ans-meta muted" style="font-family:var(--mono);font-size:11px">${esc(ansMeta(a, m))}</span>
        ${s === 'done' || s === 'error' ? `<button class="btn sm ghost" data-copy-ans="${esc(id)}" data-t="${state.turns.indexOf(t)}">复制</button>` : ''}
        </div><div class="ans-b" data-model="${esc(id)}">${answerBody(a)}</div></div>`;
    }
    h += '</div>';
  }
  for (const n of state.notes) h += `<div class="turn-q" style="white-space:pre-wrap">${esc(n)}</div>`;
  th.innerHTML = h;
  if (keep) th.scrollTop = th.scrollHeight;
}
$('#thread').addEventListener('click', e => {
  const b = e.target.closest('[data-copy-ans]'); if (!b) return;
  const a = state.turns[+b.dataset.t]?.answers?.[b.dataset.copyAns];
  if (a) copy(a.answer || a.error || '', '回复已复制');
});

/* ================= 上下文占用提示 ================= */
function renderComposerMeta() {
  const txt = $('#input').value;
  const histChars = state.turns.reduce((n, t) => n + t.q.length + Object.values(t.answers).reduce((k, a) => k + (a.answer || '').length, 0), 0);
  const est = Math.round((histChars + txt.length + (settings.system || '').length) / 3.6);
  const minCtx = state.picks.map(byId).reduce((a, m) => m ? Math.min(a ?? 1e12, m.ctx) : a, null);
  $('#ctx-line').innerHTML = state.picks.length
    ? `估算上文 ≈ ${est.toLocaleString()} tokens${minCtx ? ` / 最小窗口 ${fmtNum(minCtx)}` : ''}${est > minCtx * .8 ? ' · <span style="color:#ffcf6b">接近免费模型上下文上限，建议开新会话</span>' : ''}`
    : '未选模型 —— 在下方点左侧模型的「＋对话」加入';
}

/* ================= 测活 ================= */
async function pingAll() {
  if (!apiKey) { openSettings(); return toast('请先填写 API Key'); }
  if (!state.picks.length) return toast('先选择模型');
  if (state.running) return toast('有请求正在进行');
  const lines = ['⚡ 测活：对每个已选模型发一条 max_tokens=16 的极短请求（各计 1 次配额）'];
  state.running = true; renderComposerRunState();
  for (const id of state.picks) {
    const t0 = performance.now();
    try {
      const res = await fetch(`${API}/chat/completions`, {
        method: 'POST', headers: chatHeaders(), signal: AbortSignal.timeout(45000),
        body: JSON.stringify({ model: id, messages: [{ role: 'user', content: 'ping' }], max_tokens: 16 })
      });
      bump();
      if (!res.ok) { const e = await httpError(res); lines.push(`✗ ${byId(id)?.name || id} —— ${e.message.replace(/\n/g, ' / ')}`); continue; }
      const j = await res.json();
      const txt = j?.choices?.[0]?.message?.content || '(空)';
      lines.push(`✓ ${byId(id)?.name || id} —— ${(performance.now() - t0).toFixed(0)} ms —— ${txt.slice(0, 40)}`);
    } catch (err) {
      bump();
      lines.push(`✗ ${byId(id)?.name || id} —— ${err.name === 'TimeoutError' ? '超时 45s' : err.message}`);
    }
  }
  state.running = false; renderComposerRunState();
  state.notes.push(lines.join('\n')); renderThread(); renderComposerMeta();
}

/* ================= 弹层 ================= */
function openModal(sel) { $(sel).hidden = false; }
function closeModal(sel) { $(sel).hidden = true; }
$$('.modal').forEach(m => m.addEventListener('click', e => { if (e.target === m || e.target.closest('[data-close]')) m.hidden = true; }));
document.addEventListener('keydown', e => { if (e.key === 'Escape') $$('.modal').forEach(m => m.hidden = true); });

function openSettings() {
  $('#set-key').value = apiKey;
  $('#set-system').value = settings.system || '';
  $('#set-temp').value = settings.temp ?? '';
  $('#set-maxtok').value = settings.maxtok ?? '';
  $('#set-stream').checked = settings.stream !== false;
  openModal('#settings-modal');
}
$('#btn-settings').onclick = openSettings;
$('#settings-form').addEventListener('submit', e => {
  e.preventDefault();
  apiKey = $('#set-key').value.trim();
  settings = { system: $('#set-system').value, temp: $('#set-temp').value, maxtok: $('#set-maxtok').value, stream: $('#set-stream').checked };
  ls.set(K.key, apiKey); ls.set(K.settings, settings);
  closeModal('#settings-modal'); renderComposerMeta();
  toast(apiKey ? '已保存到本机 localStorage' : '未填 Key：只能浏览模型库，无法对话');
});
$('#btn-forget').onclick = () => {
  Object.values(K).forEach(ls.del); apiKey = ''; settings = { system: '', temp: '', maxtok: '', stream: true };
  state.turns = []; state.picks = []; state.notes = [];
  closeModal('#settings-modal'); renderAll(); toast('本机数据已清除');
};

/* ================= 渲染总入口 ================= */
function renderComposerRunState() {
  $('#btn-send').disabled = state.running; $('#input').disabled = state.running;
  $('#btn-stop').hidden = !state.running; $('#btn-ping').disabled = state.running;
  $('#btn-send').textContent = state.running ? '生成中…' : '发送';
}
function renderAll() {
  renderStats(); renderList(); renderPicks(); renderThread(); renderComposerMeta(); renderComposerRunState(); renderSource(); renderQuota();
}
function renderSource() {
  const p = $('#data-source');
  const map = { live: ['在线数据', 'ok'], cache: ['本地缓存', 'warn'], fallback: ['内置快照兜底', 'warn'], loading: ['加载中…', ''] };
  const [txt, cls] = map[state.source] || ['', ''];
  p.className = 'pill ' + cls;
  p.textContent = `${txt} · ${state.models.length} 个免费模型`;
  $('#fetched-at').textContent = state.fetchedAt ? `列表时间 ${new Date(state.fetchedAt).toLocaleString('zh-CN')}` : '内置快照，无实时时间';
}

/* ================= 事件 ================= */
let qT;
$('#q').addEventListener('input', e => { clearTimeout(qT); qT = setTimeout(() => { state.q = e.target.value; renderList(); }, 200); });
$('#sort').addEventListener('change', e => { state.sort = e.target.value; renderList(); });
$('#family').addEventListener('change', e => { state.family = e.target.value; renderList(); });
$('#flag-chips').addEventListener('change', e => {
  const f = e.target.dataset.flag; if (!f) return;
  e.target.checked ? state.flags.add(f) : state.flags.delete(f); renderList();
});
$('#btn-refresh').onclick = async () => { ls.del(K.cache); $('#data-source').textContent = '刷新中…'; await loadModels({ force: true }); toast('列表已刷新'); };
$('#btn-clear').onclick = () => {
  if (state.running) return toast('生成中，请先停止');
  if (!state.turns.length) return toast('已经是空的');
  if (!confirm('清空当前会话记录？')) return;
  state.turns = []; state.notes = []; saveTurns(); renderAll();
};
$('#btn-stop').onclick = () => { state.aborts.forEach(a => a.abort()); toast('已请求停止'); };
$('#btn-export').onclick = exportChat;
function exportChat() {
  if (!state.turns.length) return toast('没有可导出的内容');
  let mdown = '# OpenRouter 免费模型对话导出\n\n';
  for (const t of state.turns) {
    mdown += `## 问：${t.q}\n\n`;
    for (const id of Object.keys(t.answers)) {
      const a = t.answers[id];
      mdown += `### ${byId(id)?.name || id}\n\n${a.status === 'error' ? '> 失败：' + a.error : a.answer || '_(空)_'}\n\n`;
    }
  }
  const blob = new Blob([mdown], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `openrouter-free-${new Date().toISOString().slice(0, 10)}.md`;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('已导出 Markdown');
}
$('#btn-ping').onclick = pingAll;
$('#btn-send').onclick = send;

function autoGrow() {
  const t = $('#input'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 220) + 'px';
}
$('#input').addEventListener('input', () => { autoGrow(); renderComposerMeta(); });
$('#input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
$('#thread').dataset.empty = $('#thread').innerHTML;
document.addEventListener('click', e => {
  const s = e.target.closest('.sugg'); if (!s) return;
  $('#input').value = s.textContent.trim(); autoGrow(); $('#input').focus();
});

/* ================= 启动 ================= */
// 刷新/崩溃可能留下"生成中"的半截回复，恢复时一律标记为已停止，避免出现闪烁光标
state.turns.forEach(t => Object.values(t.answers || {}).forEach(a => {
  if (a.status === 'live' || a.status === 'queued') a.status = 'stopped';
}));
setInterval(() => { renderQuota(); if (!state.running) renderComposerMeta(); }, 2000);
loadModels();
renderAll();
// 首次访问弹一次设置（之后靠点「发送」时的提示，不再反复打扰）
if (!apiKey && !ls.get(K.seen, false)) { ls.set(K.seen, true); setTimeout(openSettings, 700); }
})();
