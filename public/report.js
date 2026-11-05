const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const IMAGE_PREFIX=['data:image/jpeg;base64,','data:image/png;base64,','data:image/webp;base64,'];
const safe=value=>{try{const u=new URL(value);if(u.protocol==='data:')return IMAGE_PREFIX.some(prefix=>u.href.startsWith(prefix))?escape(u.href):'';return ['https:','http:'].includes(u.protocol)?escape(u.href):'';}catch{return '';}};
const status=data=>data?.state==='pending'?'查询中':data?.state==='unavailable'||!data?'暂时无法查询':data.items?.some(i=>i.exactMatch)?(data.stale?'曾找到本文':'找到本文'):'暂未确认收录';
const link=(url,text)=>safe(url)?`<a href="${safe(url)}" rel="noopener noreferrer">${escape(text||url)}</a>`:escape(text||url);
// 把一段纯文本里的网址转成可点链接，并标注它属于哪一类：
//   页内锚点（目录跳转，指向本文自身） / 站内互链（同站其他文章） / 外部链接
// 原稿对比里「发布正文新增链接」大多是媒体自动加的目录锚点，
// 不标注清楚，客户会误以为文章里新增了多个外部品牌链接。
function linkify(text,pageUrl){
 const esc=escape(text);
 let base=null;try{base=pageUrl?new URL(pageUrl):null;}catch{base=null;}
 return esc.replace(/https?:\/\/[^\s<>"')]+/g,m=>{
  const url=m.replace(/[.,;:)\]]+$/,''),tail=m.slice(url.length);
  let tag='';
  try{
   const u=new URL(url);
   if(base&&u.origin===base.origin){
    const norm=p=>p.replace(/\/+$/,'');
    tag=norm(u.pathname)===norm(base.pathname)
      ?' <span class="tag">页内锚点</span>'
      :' <span class="tag">站内互链</span>';
   }else tag=' <span class="tag ext">外部链接</span>';
  }catch{}
  return `<a href="${url}" rel="noopener noreferrer" target="_blank">${url}</a>${tag}${tail}`;
 });
}
// 同标题的差异合成一张表：原来 6 条「超链接 · 发布正文新增链接」会渲染成
// 6 个重复标题 + 6 张单行表，报告读起来很长且看不出条数。
export function diffGroups(diffs){
 const order=[],map=new Map();
 (diffs||[]).forEach(d=>{
  const key=`${d.type||''} · ${d.detail||''}`;
  if(!map.has(key)){map.set(key,[]);order.push(key);}
  map.get(key).push({before:d.before||'',after:d.after||''});
 });
 return order.map(key=>({key,rows:map.get(key)}));
}
function groupDiffs(diffs,pageUrl){
 return diffGroups(diffs).map(g=>{
  const body=g.rows.map(r=>`<tr><td>${escape(r.before||'—')}</td><td>${linkify(r.after||'—',pageUrl)}</td></tr>`).join('');
  const count=g.rows.length>1?` <small class="count">共 ${g.rows.length} 处</small>`:'';
  return `<article><h3>${escape(g.key)}${count}</h3><table><thead><tr><th>客户的原稿</th><th>发布的文章</th></tr></thead><tbody>${body}</tbody></table></article>`;
 }).join('');
}
const SHOT_ORDER=[['article','文章正文'],['section','频道栏目页'],['homepage','媒体首页'],['google','谷歌搜索结果页']];
// 截图按单列铺满整幅宽度（约 950px），比原来的两栏小图大一倍；
// 点击可在新窗口打开压缩包「截图/」目录里的原图。
function shotsBlock(shots,embedded){
 const ok=SHOT_ORDER.map(([key,label])=>({key,label,shot:shots?.[key]})).filter(x=>x.shot&&x.shot.state==='ok');
 const rows=ok.map(({key,label,shot},i)=>{
  const src=embedded?.[key]||(shot.src?new URL(shot.src,location.origin).href:'');
  if(!safe(src))return '';
  const file=`screenshots/${String(i+1).padStart(2,'0')}-${key}.jpg`;
  return `<figure><a href="${escape(file)}" target="_blank" rel="noopener"><img src="${safe(src)}" alt="${escape(label)}截图" loading="lazy"></a><figcaption><strong>${escape(label)}</strong>${shot.note?' · '+escape(shot.note):''}<span class="file">${escape(file)}</span></figcaption></figure>`;
 }).filter(Boolean);
 const missing=SHOT_ORDER.filter(([key])=>shots?.[key]&&shots[key].state!=='ok').map(([,label])=>label);
 if(!rows.length){
  if(!missing.length)return '';
  return `<section><h2>发布截图</h2><p>本次未能生成截图（${escape(missing.join('、'))}）。媒体页面可能访问受限或截图超时，可稍后重新查询。</p></section>`;
 }
 const missNote=missing.length?`未生成：${escape(missing.join('、'))}。`:'';
 return `<section><h2>发布截图</h2><div class="shots">${rows.join('')}</div><small>截图为查询当时的页面画面，页面后续更新不影响本次记录。${missNote}</small></section>`;
}
export function buildHtmlReport(result,comparison,{comparisonPending=false,comparisonError='',shotImages=null}={}){
 const analysis=result.analysis,labels={dofollow:'Dofollow Link',nofollow:'标注不跟随',sponsored:'赞助链接',ugc:'用户发布链接'};
 const search=(title,data)=>`<section><h2>${escape(title)}</h2><p>${status(data)}</p>${data?.manualVerified?'<p>已通过谷歌网页复核，展示已保存结果。</p>':''}${data?.stale?'<p>本次接口未能确认，以下为上次成功查询记录。</p>':''}<ol>${(data?.items||[]).slice(0,5).map(item=>`<li>${link(item.url,item.title)}${item.exactMatch?' <b class="ok">这篇文章</b>':''}<p>${escape(item.snippet||'')}</p></li>`).join('')}</ol><small>查询时间：${escape(data?.checkedAt||'未完成')}${data?.cached?' · 已保存结果':''}</small></section>`;
 const hasComparison=!!comparison||comparisonPending||!!comparisonError;
 let compare='';
 if(hasComparison){
  if(comparisonPending)compare='<p>原稿仍在比对，本报告暂未包含最终简报。</p>';
  else if(comparisonError)compare=`<p>比对未完成：${escape(comparisonError)}</p>`;
  else if(comparison)compare=`<p class="lead">${escape(comparison.summary)}</p><p class="meta">客户的原稿：${escape(comparison.sourceName)} · 实质差异 ${comparison.counts.differences} 处 · 待确认 ${comparison.counts.pending} 项 · 已排除细微差异 ${comparison.counts.ignored} 处</p>${comparison.same?.length?`<p class="ok">未见明显差异：${escape(comparison.same.join('、'))}</p>`:''}${groupDiffs(comparison.differences,result.finalUrl||result.requestedUrl)}${comparison.pending.length?`<h3>仍需确认</h3><ul>${comparison.pending.map(p=>`<li>${escape(p)}</li>`).join('')}</ul>`:''}<small>忽略排版、标点、大小写及轻微措辞变化；重要修改请结合原稿复核。${comparison.truncated?'当前列出前 30 项差异。':''}</small>`;
 }
 const title=hasComparison?'媒体文章查询与原稿对比报告':'媒体文章查询报告';
 return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${title}</title><style>body{font:15px/1.75 system-ui,"Microsoft YaHei",sans-serif;color:#173449;background:#f3f6f8;margin:0}main{max-width:1000px;padding:30px 22px;margin:auto}header{background:#0d2b42;color:white;padding:28px;border-radius:15px}h1{font-size:27px;margin:0}header p{margin:8px 0 0;overflow-wrap:anywhere}section{background:white;border:1px solid #dce7ed;padding:24px;margin-top:20px;border-radius:12px}h2{font-size:20px;margin:0 0 15px}h3{font-size:16px}a{color:#276984;overflow-wrap:anywhere}table{border-collapse:collapse;width:100%;table-layout:fixed}td,th{border:1px solid #dce7ed;padding:12px;vertical-align:top;text-align:left;white-space:pre-wrap;overflow-wrap:anywhere}th{background:#eaf2f5}article{margin:18px 0}small{color:#647b88}.ok{color:#26776b}li{margin:10px 0}li p{margin:4px 0;color:#597482}.tag{display:inline-block;font-size:12px;line-height:1.5;padding:1px 8px;border-radius:9px;background:#e8f0f4;color:#42667a;white-space:nowrap}.tag.ext{background:#e3f1ec;color:#26776b}.count{color:#647b88;font-weight:400}.shots{display:grid;grid-template-columns:1fr;gap:24px}.shots a{display:block}.shots img{width:100%;height:auto;display:block;border:1px solid #dce7ed;border-radius:10px}.shots figcaption{font-size:12px;color:#647b88;margin-top:6px}.shots .file{color:#93a7b2;margin-left:8px}.meta{color:#5c7484;margin:0 0 14px}.lead{font-size:16px;line-height:1.85;color:#173449;background:#f4f9fb;border-left:3px solid #276984;padding:14px 16px;border-radius:6px;margin:0 0 14px}@media print{body{background:white}section,header{break-inside:avoid}a{color:inherit}}@media(max-width:600px){main{padding:12px}section{padding:16px}td,th{padding:8px;font-size:12px}}</style></head><body><main><header><h1>${title}</h1><p>${escape(analysis?.title||'文章查询')}</p><p>${escape(result.finalUrl||result.requestedUrl)}</p><p>查询时间：${escape(result.checkedAt)}${result.pending?' · 部分项目仍在查询':''}</p></header><section><h2>媒体发布情况</h2><table><tbody><tr><th>文章访问</th><td>${result.readable?'正常打开':result.pagePending?'正在读取':'暂时无法读取'}</td></tr><tr><th>文章栏目</th><td>${escape(analysis?.section?.name||'媒体未标注')}</td></tr><tr><th>文章阅读量</th><td>${escape(analysis?.views?.value||'媒体未公开')}</td></tr><tr><th>媒体首页展示</th><td>${result.homepage?.state==='found'?'首页有本文链接':result.homepage?.state==='not_found'?'首页未见本文链接':result.homepage?.state==='pending'?'正在核查':'暂未确认'}</td></tr></tbody></table></section><section><h2>正文品牌链接</h2><table><thead><tr><th>链接文字（锚文本）</th><th>目标网址</th><th>链接类型</th></tr></thead><tbody>${(analysis?.links?.items||[]).map(item=>`<tr><td>${escape(item.anchor)}</td><td>${link(item.url)}</td><td>${escape(item.attributes.map(a=>labels[a]||a).join('、'))}</td></tr>`).join('')}</tbody></table>${!analysis?.links?.items?.length?'<p>未发现可确认的正文品牌链接。</p>':''}</section>${search('谷歌收录',result.siteSearch)}<p><small>未找到本文，不代表未被谷歌收录。</small></p>${shotsBlock(result.shots,shotImages)}${hasComparison?`<section><h2>原稿对比简报</h2>${compare}</section>`:''}<p><small>Article Link Checker · 开源工具，本地部署</small></p></main></body></html>`;
}
