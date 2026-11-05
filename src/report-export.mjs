/**
 * 报告导出：HTML + 截图原图 + 带修订模式的 Word，打成 zip。
 * 由 server.mjs 的 /api/article-report 调用。
 */
import JSZip from 'jszip';
import fs from 'node:fs/promises';
import path from 'node:path';

import {SHOT_DIR as CONFIG_SHOT_DIR, REPORT_AUTHOR} from './config.mjs';
const SHOT_DIR = CONFIG_SHOT_DIR;
const SHOT_RE = /^\/api\/article-shot\/([a-f0-9]{32})\.jpg$/;
const MIN_BYTES = 100 * 1024;
const ORDER = [['article', '文章正文'], ['section', '频道栏目页'], ['homepage', '媒体首页'], ['google', '谷歌搜索结果页']];

/* ---------- 截图：保证每张不小于 100KB ---------- */
async function ensureSize(buffer) {
  if (buffer.length >= MIN_BYTES) return buffer;
  let scale = 1.6;
  let source = buffer;
  for (let i = 0; i < 4; i++) {
    try {
      const { createCanvas, loadImage } = await import('@napi-rs/canvas');
      const img = await loadImage(source);
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = createCanvas(w, h);
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, w, h);
      const out = await canvas.encode('jpeg', 95);
      if (out.length >= MIN_BYTES) return out;
      source = out;
      scale = 1.3;
    } catch {
      break;
    }
  }
  return buffer;
}

async function collectShots(shots) {
  const list = [];
  for (const [key, label] of ORDER) {
    const item = (shots || []).find((s) => s && s.key === key);
    if (!item) continue;
    const match = SHOT_RE.exec(String(item.src || ''));
    if (!match) continue;
    try {
      const file = path.join(SHOT_DIR, match[1] + '.jpg');
      const raw = await fs.readFile(file);
      const buffer = await ensureSize(raw);
      list.push({ key, label, name: `${String(list.length + 1).padStart(2, '0')}-${key}.jpg`, buffer });
    } catch {
      /* 截图已被清理则跳过，报告里仍有内嵌版本 */
    }
  }
  return list;
}

/* ---------- Word：最小可用 docx + 修订标记 ---------- */
const xmlEsc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
const flat = (s) => String(s ?? '').replace(/\s*\n+\s*/g, ' ／ ').trim();

const rPr = ({ bold, size, color } = {}) => {
  const bits = [];
  if (bold) bits.push('<w:b/>');
  if (color) bits.push(`<w:color w:val="${color}"/>`);
  if (size) bits.push(`<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>`);
  return bits.length ? `<w:rPr>${bits.join('')}</w:rPr>` : '';
};
const runs = (text, opts = {}) => `<w:r>${rPr(opts)}<w:t xml:space="preserve">${xmlEsc(flat(text))}</w:t></w:r>`;
const para = (inner, { style, after, align } = {}) => {
  const ppr = [];
  if (style) ppr.push(`<w:pStyle w:val="${style}"/>`);
  if (after != null) ppr.push(`<w:spacing w:after="${after}"/>`);
  if (align) ppr.push(`<w:jc w:val="${align}"/>`);
  return `<w:p>${ppr.length ? `<w:pPr>${ppr.join('')}</w:pPr>` : ''}${inner}</w:p>`;
};
const revIns = (text, id, date) => `<w:ins w:id="${id}" w:author="${REPORT_AUTHOR}" w:date="${date}">${runs(text)}</w:ins>`;
const revDel = (text, id, date) => `<w:del w:id="${id}" w:author="${REPORT_AUTHOR}" w:date="${date}"><w:r><w:delText xml:space="preserve">${xmlEsc(flat(text))}</w:delText></w:r></w:del>`;

const EMPTY = new Set(['', '无', '—', '-', '未找到']);

function buildDocumentXml({ meta, comparison, shots, stamp }) {
  const date = stamp || new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  let id = 100;
  const body = [];
  const add = (xml) => body.push(xml);

  add(para(runs('媒体文章对比修订记录', { bold: true, size: 40, color: '0D2B42' }), { style: 'Title', after: 240 }));
  add(para(runs(meta.title || '文章查询', { bold: true, size: 28 }), { style: 'Heading1', after: 120 }));
  add(para(runs('文章网址：' + (meta.url || ''), { size: 18, color: '555555' }), { after: 40 }));
  add(para(runs('查询时间：' + (meta.checkedAt || ''), { size: 18, color: '555555' }), { after: 40 }));
  if (comparison?.sourceName) add(para(runs('客户原稿：' + comparison.sourceName, { size: 18, color: '555555' }), { after: 40 }));

  add(para(runs('一、对比简报', { bold: true, size: 26 }), { style: 'Heading2', after: 120 }));
  add(para(runs(comparison?.summary || '暂无简报。', { size: 21 })));
  if (comparison?.same?.length) add(para(runs('未见明显变化：' + comparison.same.join('、'), { size: 21, color: '26776B' })));

  add(para(runs('二、修改明细（修订模式）', { bold: true, size: 26 }), { style: 'Heading2', after: 80 }));
  add(para(runs('删除线为原稿内容，下划线为发布版内容；可在 Word「审阅」中逐条接受或拒绝。', { size: 18, color: '666666' }), { after: 160 }));

  const groups = comparison?.groups || [];
  if (!groups.length) {
    add(para(runs('本次未发现需要标注的实质修改。', { size: 21 })));
  } else {
    groups.forEach((group, gi) => {
      add(para(runs(`${String(gi + 1).padStart(2, '0')} · ${group.key}`, { bold: true, size: 22 }), { after: 80 }));
      (group.rows || []).forEach((row) => {
        const before = String(row.before ?? '').trim();
        const after = String(row.after ?? '').trim();
        const left = [runs('原稿：', { bold: true, size: 20 })];
        if (!EMPTY.has(before)) left.push(revDel(before, id++, date));
        else left.push(runs('（原稿无此内容）', { size: 20, color: '888888' }));
        add(para(left.join(''), { after: 0 }));
        const right = [runs('发布：', { bold: true, size: 20 })];
        if (!EMPTY.has(after)) right.push(revIns(after, id++, date));
        else right.push(runs('（发布版未保留）', { size: 20, color: '888888' }));
        add(para(right.join(''), { after: 160 }));
      });
    });
  }

  if (comparison?.pending?.length) {
    add(para(runs('三、仍需确认', { bold: true, size: 26 }), { style: 'Heading2', after: 80 }));
    comparison.pending.forEach((p) => add(para(runs('· ' + p, { size: 20 }), { after: 40 })));
  }

  add(para(runs('四、截图文件 Screenshots', { bold: true, size: 26 }), { style: 'Heading2', after: 80 }));
  if (shots.length) shots.forEach((s) => add(para(runs(`screenshots/${s.name} (${Math.round(s.buffer.length / 1024)} KB)`, { size: 20 }), { after: 40 })));
  else add(para(runs('本次未生成可用截图。', { size: 20, color: '888888' })));

  add(para(runs('说明：' + (comparison?.rule || '忽略排版、大小写、标点及轻微措辞变化。'), { size: 18, color: '666666' }), { after: 0 }));

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1247" w:right="1247" w:bottom="1247" w:left="1247" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr></w:body></w:document>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:eastAsia="宋体" w:hAnsi="Calibri"/><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/><w:rPr><w:b/><w:sz w:val="40"/><w:szCs w:val="40"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:qFormat/><w:rPr><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:qFormat/><w:rPr><w:b/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style>
</w:styles>`;

const SETTINGS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:trackChanges/><w:defaultTabStop w:val="420"/><w:characterSpacingControl w:val="doNotCompress"/></w:settings>`;

function coreXml({ meta }) {
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlEsc(meta.title || '文章对比修订记录')}</dc:title><dc:creator>${xmlEsc(REPORT_AUTHOR)}</dc:creator><cp:lastModifiedBy>${xmlEsc(REPORT_AUTHOR)}</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/></Relationships>`;

async function buildDocx(payload) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.folder('_rels').file('.rels', ROOT_RELS);
  zip.folder('docProps').file('core.xml', coreXml(payload));
  const word = zip.folder('word');
  word.file('document.xml', buildDocumentXml(payload));
  word.file('styles.xml', STYLES);
  word.file('settings.xml', SETTINGS);
  word.folder('_rels').file('document.xml.rels', DOC_RELS);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

/* ---------- 打包 ---------- */
export async function buildExportBundle({ html, meta = {}, comparison = null, shots = [] }) {
  const day = new Date().toISOString().slice(0, 10);
  const shotFiles = await collectShots(shots);
  const docxBuffer = await buildDocx({ meta, comparison, shots: shotFiles });
  const zip = new JSZip();
  const htmlName = `article-report-${day}.html`;
  const docxName = `article-redline-${day}.docx`;
  if (html) zip.file(htmlName, html);
  zip.file(docxName, docxBuffer);
  const folder = zip.folder('screenshots');
  shotFiles.forEach((s) => folder.file(s.name, s.buffer));
  zip.file(
    '说明.txt',
    [
      '本压缩包包含三个部分：',
      `1. ${htmlName} —— 图文报告，截图已内嵌，双击即可用浏览器打开，离线可看。`,
      `2. ${docxName} —— Word 修订稿，删除线为原稿内容、下划线为发布版内容，可在「审阅」中逐条接受或拒绝。`,
      '3. screenshots/ — full-size captures, ready for decks or client emails.',
      '',
      `导出时间：${new Date().toISOString().replace('T', ' ').slice(0, 19)} (UTC)`,
      `文章：${meta.url || ''}`,
    ].join('\r\n')
  );
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return {
    buffer,
    htmlName,
    docxName,
    shots: shotFiles.map((s) => ({ name: s.name, bytes: s.buffer.length })),
  };
}
