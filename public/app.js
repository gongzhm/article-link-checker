import { buildHtmlReport, diffGroups } from './report.js';

const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const SHOT_LABELS = { article: '文章正文', section: '频道栏目页', homepage: '媒体首页', google: '谷歌搜索结果页' };
const ATTR_LABELS = { dofollow: 'dofollow', nofollow: 'nofollow', sponsored: 'sponsored', ugc: 'ugc' };

let result = null;
let jobId = null;
let pollTimer = null;
let comparison = null;
let compareBusy = false;
let compareJob = null;

/* ---------- 查询 ---------- */
async function startCheck(event) {
  event.preventDefault();
  const url = $('#url').value.trim();
  const targetDomain = $('#domain').value.trim();
  if (!url) return;
  clearTimeout(pollTimer);
  result = null; comparison = null; compareJob = null;
  $('#result').hidden = true;
  $('#compare-card').hidden = true;
  $('#error').hidden = true;
  setBusy(true, '检测中…');
  try {
    const response = await fetch('/api/article-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, targetDomain }),
    });
    const data = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    if (!response.ok) throw new Error(data.error || '查询失败');
    result = data;
    jobId = data.jobId;
    $('#result').hidden = false;
    $('#compare-card').hidden = false;
    render();
    poll();
  } catch (error) {
    $('#error').hidden = false;
    $('#error').textContent = error.message || '查询失败，请稍后重试。';
  } finally {
    setBusy(false, '开始检测');
  }
}

function poll() {
  const started = Date.now();
  const tick = async () => {
    if (!jobId) return;
    if (Date.now() - started > 120000) return;
    try {
      const response = await fetch('/api/article-check?job=' + encodeURIComponent(jobId));
      if (response.status === 404) { if (result) { result.pending = false; render(); } return; }
      if (!response.ok) throw new Error();
      const data = await response.json();
      if (data.jobId !== jobId) return;
      result = data;
      render();
      if (!data.pending) return;
    } catch { /* 网络抖动，继续轮询 */ }
    pollTimer = setTimeout(tick, 1500);
  };
  pollTimer = setTimeout(tick, 900);
}

function setBusy(busy, label) {
  const button = $('#submit');
  button.disabled = busy;
  button.innerHTML = busy ? `<span class="spin"></span>${esc(label)}` : esc(label);
}

/* ---------- 渲染 ---------- */
function render() {
  if (!result) return;
  const analysis = result.analysis || {};
  const links = analysis.links || {};
  $('#r-title').textContent = analysis.title || '（未能读取标题）';
  $('#r-url').textContent = result.finalUrl || result.requestedUrl;

  const notice = $('#notice');
  if (result.pending) {
    notice.hidden = false;
    notice.textContent = '部分项目仍在查询（截图 / 谷歌收录），页面会自动更新…';
  } else if (result.note) {
    notice.hidden = false;
    notice.textContent = result.note;
  } else {
    notice.hidden = true;
  }

  const okShots = Object.values(result.shots || {}).filter((s) => s?.state === 'ok').length;
  const metrics = [
    ['文章访问', result.pagePending ? '正在读取' : result.readable ? '正常打开' : '无法读取'],
    ['品牌链接', links.state === 'ok' ? `${links.total} 个` : result.pagePending ? '识别中' : '未确认'],
    ['谷歌收录', searchLabel(result.siteSearch)],
    ['截图', okShots ? `${okShots} 张` : Object.values(result.shots || {}).some((s) => s?.state === 'pending') ? '生成中' : '未生成'],
  ];
  $('#metrics').innerHTML = metrics.map(([k, v]) => `<div class="metric"><b>${esc(k)}</b><span>${esc(v)}</span></div>`).join('');

  renderLinks(links);
  renderShots(result.shots);
  renderSearch(result.siteSearch);
  renderCompare();
}

function searchLabel(data) {
  if (!data) return '未查询';
  if (data.state === 'pending') return '查询中';
  if (data.state === 'unavailable') return '不可用';
  if ((data.items || []).some((i) => i.exactMatch)) return data.stale ? '曾找到本文' : '找到本文';
  return '暂未确认';
}

function renderLinks(links) {
  const items = (links.items || []).filter((i) => i.targetMatch);
  if (!items.length) {
    $('#links').innerHTML = `<h3>正文品牌链接<span class="badge">0</span></h3><p class="empty">${result.pagePending ? '正在识别…' : '未发现可确认的品牌链接。若文章确实带了链接，检查「品牌域名」是否填写正确。'}</p>`;
    return;
  }
  const rows = items.map((item) => `<tr>
      <td>${esc(item.anchor || '（图片链接）')}</td>
      <td><a href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">${esc(item.url)}</a></td>
      <td>${(item.attributes || []).map((a) => `<span class="tag">${esc(ATTR_LABELS[a] || a)}</span>`).join(' ')}</td>
    </tr>`).join('');
  $('#links').innerHTML = `<h3>正文品牌链接<span class="badge">${items.length}</span></h3>
    <table><thead><tr><th style="width:32%">锚文本</th><th>目标网址</th><th style="width:18%">类型</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderShots(shots) {
  const entries = Object.entries(shots || {}).filter(([, s]) => s?.state === 'ok' && s.src);
  const pending = Object.entries(shots || {}).filter(([, s]) => s?.state === 'pending').map(([k]) => SHOT_LABELS[k] || k);
  if (!entries.length) {
    $('#shots').innerHTML = pending.length
      ? `<h3>发布截图</h3><p class="empty">正在生成：${esc(pending.join('、'))}…</p>`
      : '<h3>发布截图</h3><p class="empty">本次未生成截图（页面可能有访问限制，或截图超时）。</p>';
    return;
  }
  const figures = entries.map(([key, shot]) => `<figure>
      <a href="${esc(shot.src)}" target="_blank" rel="noopener"><img src="${esc(shot.src)}" alt="${esc(SHOT_LABELS[key] || key)}" loading="lazy"></a>
      <figcaption><strong>${esc(SHOT_LABELS[key] || key)}</strong>${shot.note ? ' · ' + esc(shot.note) : ''}</figcaption>
    </figure>`).join('');
  $('#shots').innerHTML = `<h3>发布截图<span class="badge">${entries.length}</span></h3><div class="shots">${figures}</div>`;
}

function renderSearch(data) {
  if (!data) { $('#search').innerHTML = ''; return; }
  if (data.state === 'unavailable') {
    $('#search').innerHTML = `<h3>谷歌收录</h3><p class="empty">${esc(data.note || '未配置检索服务，已跳过。')}</p>`;
    return;
  }
  const items = (data.items || []).slice(0, 5);
  const rows = items.map((item, i) => `<tr>
      <td style="width:34px">${i + 1}</td>
      <td><a href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">${esc(item.title || item.url)}</a>
      ${item.exactMatch ? '<span class="tag ext">这篇文章</span>' : ''}
      ${item.snippet ? `<div class="empty">${esc(item.snippet)}</div>` : ''}</td>
    </tr>`).join('');
  $('#search').innerHTML = `<h3>谷歌收录<span class="badge">${esc(searchLabel(data))}</span></h3>
    ${items.length ? `<table><tbody>${rows}</tbody></table>` : '<p class="empty">没有返回结果。未找到不代表未被收录。</p>'}
    ${data.searchUrl ? `<p class="muted"><a href="${esc(data.searchUrl)}" target="_blank" rel="noopener noreferrer">到谷歌手动复核</a></p>` : ''}`;
}

function renderCompare() {
  const box = $('#compare');
  if (!comparison) { box.innerHTML = ''; return; }
  if (compareBusy) { box.innerHTML = '<h3>原稿对比</h3><p class="empty">正在比对…</p>'; return; }
  const groups = diffGroups(comparison.differences || []);
  const rows = groups.map((group) => {
    const body = group.rows.map((r) => `<tr><td>${esc(r.before || '—')}</td><td>${esc(r.after || '—')}</td></tr>`).join('');
    return `<h3>${esc(group.key)}${group.rows.length > 1 ? `<span class="badge">共 ${group.rows.length} 处</span>` : ''}</h3>
      <table><thead><tr><th>客户的原稿</th><th>发布的文章</th></tr></thead><tbody>${body}</tbody></table>`;
  }).join('');
  box.innerHTML = `<h3>原稿对比简报</h3>
    <p class="lead">${esc(comparison.summary || '')}</p>
    <p class="muted">实质差异 ${comparison.counts?.differences ?? 0} 处 · 待确认 ${comparison.counts?.pending ?? 0} 项 · 已排除细微差异 ${comparison.counts?.ignored ?? 0} 处</p>
    ${comparison.same?.length ? `<p class="muted">未见明显变化：${esc(comparison.same.join('、'))}</p>` : ''}
    ${rows || '<p class="empty">未发现需要标注的实质修改。</p>'}
    ${comparison.pending?.length ? `<p class="muted">仍需确认：${esc(comparison.pending.join('；'))}</p>` : ''}`;
}

/* ---------- 原稿对比 ---------- */
async function onFile(event) {
  const file = event.target.files?.[0];
  if (!file || !result) return;
  const status = $('#compare-status');
  compareBusy = true;
  renderCompare();
  status.hidden = false;
  status.textContent = `正在上传并比对 ${file.name}…`;
  try {
    const base64 = await toBase64(file);
    const response = await fetch('/api/article-compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: result.finalUrl || result.requestedUrl, file: { name: file.name, data: base64 } }),
    });
    const data = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    if (!response.ok) throw new Error(data.error || '比对失败');
    compareJob = data.jobId;
    await pollCompare();
  } catch (error) {
    status.textContent = error.message || '比对失败。';
  } finally {
    compareBusy = false;
    renderCompare();
  }
}

async function pollCompare() {
  const started = Date.now();
  while (compareJob && Date.now() - started < 90000) {
    await new Promise((r) => setTimeout(r, 2000));
    const response = await fetch('/api/article-compare?job=' + encodeURIComponent(compareJob));
    if (response.status === 404) break;
    const data = await response.json();
    if (!data.pending) {
      if (data.error) { $('#compare-status').textContent = data.error; return; }
      comparison = data.report;
      $('#compare-status').hidden = true;
      render();
      return;
    }
  }
  $('#compare-status').textContent = '比对超时，请稍后重试。';
}

function toBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* ---------- 导出 ---------- */
async function download() {
  if (!result) return;
  const button = $('#download');
  button.disabled = true;
  button.textContent = '打包中…';
  try {
    const shotImages = {};
    await Promise.all(Object.entries(result.shots || {}).map(async ([key, shot]) => {
      if (shot?.state !== 'ok' || !shot.src) return;
      try {
        const blob = await (await fetch(shot.src)).blob();
        if (blob.size > 4e6) return;
        shotImages[key] = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      } catch { /* 截图过期则跳过，报告里会用原链接 */ }
    }));
    const html = buildHtmlReport(result, comparison, { shotImages });
    const payload = {
      html,
      meta: {
        title: result.analysis?.title || '',
        url: result.finalUrl || result.requestedUrl,
        checkedAt: new Date(result.checkedAt).toLocaleString('zh-CN', { hour12: false }),
      },
      comparison: comparison
        ? {
            summary: comparison.summary, counts: comparison.counts, same: comparison.same || [],
            pending: comparison.pending || [], rule: comparison.rule, sourceName: comparison.sourceName,
            groups: diffGroups(comparison.differences || []),
          }
        : null,
      shots: Object.entries(result.shots || {})
        .filter(([, s]) => s?.state === 'ok' && s.src)
        .map(([key, s]) => ({ key, src: s.src })),
    };
    const response = await fetch('/api/article-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error('导出失败');
    const blob = await response.blob();
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = `article-check-report-${new Date().toISOString().slice(0, 10)}.zip`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(href), 30000);
  } catch {
    alert('导出失败，请稍后重试。');
  } finally {
    button.disabled = false;
    button.textContent = '下载报告包';
  }
}

/* ---------- 事件 ---------- */
$('#form').addEventListener('submit', startCheck);
$('#sample').addEventListener('click', () => {
  $('#url').value = 'https://www.thepaintedhinge.com/how-to-shape-a-contemporary-living-room-around-a-modern-leather-sofa/';
  $('#domain').value = 'flexispot.com';
});
$('#file').addEventListener('change', onFile);
$('#download').addEventListener('click', download);
