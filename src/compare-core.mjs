import {diffArrays} from 'diff';
import {imageKey,sameImage} from './image-match.mjs';
import {parse} from 'tldts';
export const normalize=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]/gu,'');
const tokens=s=>(String(s||'').normalize('NFKC').toLowerCase().match(/[\p{Script=Han}]|[\p{L}\p{N}]+/gu)||[]);
const excerpt=s=>String(s||'').slice(0,450);
function score(a,b){const x=tokens(a),y=tokens(b);if(!x.length||!y.length)return 0;const diff=diffArrays(x,y,{timeout:15,maxEditLength:600});if(!diff)return 0;return 2*diff.filter(d=>!d.added&&!d.removed).reduce((n,d)=>n+d.count,0)/(x.length+y.length);}
function critical(s){return JSON.stringify({numbers:(String(s).match(/\d+(?:[.,]\d+)*(?:\s*%|万|亿)?/g)||[]).sort(),negations:(String(s).toLowerCase().match(/\b(?:not|no|never|without|cannot|can't|must|shall)\b|不|未|无|禁止/g)||[]).sort()});}
// 「细微差异」= 标点/大小写/空白，或只换了虚词与语序；
// 只要动了实词（中文非虚词单字、英文 3 字母以上的词）就算实质变化，单独列出。
const STOP_EN=new Set('a an the and or but if then than that this these those of in on at to for from with by as is are was were be been being it its their our your we you they he she his her not no more most very can may might must should would could shall will just into over under about after before while when where what which who whom whose also such only other some any each both few many much own same so too s t don now'.split(' '));
const STOP_ZH=new Set('的了是在和也就都而及与等这那有被把为对之其以及我你他她它我们你们他们很更最会能可要让给从向于并且但因为所以如果虽然然后还是就是没有不会可以一个一些这个那个'.split(''));
const isContent=w=>/^[\u4e00-\u9fa5]+$/.test(w)?![...w].every(c=>STOP_ZH.has(c)):(w.length>2&&!STOP_EN.has(w)&&!/^\d+$/.test(w));
function contentDiff(a,b){
 const d=diffArrays(tokens(a),tokens(b),{timeout:15,maxEditLength:600})||[];
 const pick=k=>[...new Set(d.filter(t=>t[k]).flatMap(t=>t.value).filter(isContent))];
 return {removed:pick('removed'),added:pick('added')};
}
export function minorChange(a,b,protectedWords=[]){const x=tokens(a),y=tokens(b);if(normalize(a)===normalize(b))return true;const s=score(a,b);if(s<.78)return false;if(critical(a)!==critical(b))return false;if(!protectedWords.every(w=>x.filter(t=>t===w).length===y.filter(t=>t===w).length))return false;
 const {removed,added}=contentDiff(a,b);
 return !removed.length&&!added.length;}
// 同一段落被媒体拆成多句时，逐句列出会让报告刷屏；按相似度聚成一处。
function clusterPairs(pairs){
 const groups=[];
 for(const p of pairs){
  const hit=groups.find(g=>score(g.before,p.before)>=.5);
  if(hit){hit.count++;if(p.before.length>hit.before.length)hit.before=p.before;if(p.after.length>hit.after.length)hit.after=p.after;}
  else groups.push({...p,count:1});
 }
 return groups;
}
function urlKey(value){try{const u=new URL(value);u.hash='';for(const k of [...u.searchParams.keys()])if(/^(utm_.+|gclid|fbclid|msclkid)$/i.test(k))u.searchParams.delete(k);u.searchParams.sort();return u.href.replace(/\/$/,'');}catch{return value;}}
// 目录、广告位、分享条这类结构性文字不是正文改动，混进来会让「新增 N 处」虚高
const JUNK=/^(inhaltsverzeichnis|table of ?contents?|contents|anzeigen|advertisement|werbung|kommentare?|comments?|teilen|share|related|lesen sie auch|weiterlesen|das könnte sie|mehr zum thema|zur startseite)\b/i;
const isHeadingish=x=>x.length<70&&!/[.!?。！？:]$/.test(x);
function sentences(text){return String(text).replace(/(?<=[a-z\d])\.(?=[A-Z])/g,'. ').split(/\n+|(?<=[。！？!?])\s*|(?<=[.])\s+(?=[A-Z])/u).map(x=>x.trim()).filter(x=>x.length>=8&&!JUNK.test(x));}
function makeSummary({differences,ignored,pending,same,counts}){
 const byType={};for(const d of differences)byType[d.type]=(byType[d.type]||0)+1;
 const order=['标题','锚文本','超链接','图片','正文'].filter(t=>byType[t]);
 const bits=[`本次对比核对标题、${counts.originalLinks} 个原稿链接、${counts.originalImages} 张配图与正文内容。`];
 if(differences.length)bits.push(`发布版有 ${differences.length} 处实质变动：${order.map(t=>`${t} ${byType[t]} 处`).join('、')}。`);
 else bits.push(pending.length?'已核对的部分未发现实质差异，仍有项目待确认。':'未发现实质差异，发布版与原稿一致。');
 if(ignored)bits.push(`另有 ${ignored} 处标点、大小写与同义措辞的细微调整，已按规则排除。`);
 if(same.length)bits.push(`${same.join('、')}未见实质变化。`);
 return bits.join('');
}
export function compareDocuments(original,published){
 const differences=[],pending=[],same=[];let ignored=0;
 const protectedWords=[...new Set(original.links.map(l=>parse(l.url).domainWithoutSuffix).filter(x=>x&&x.length>=4))];
 const add=(type,detail,before='',after='',level='change')=>differences.push({type,detail,before:excerpt(before),after:excerpt(after),level});
 if(!original.title)pending.push('原稿没有明确标题，标题未核实。');else if(minorChange(original.title,published.title,protectedWords)){same.push('标题');if(normalize(original.title)!==normalize(published.title))ignored++;}else add('标题','发布标题与原稿不同',original.title,published.title);
 const used=new Set();
 for(const link of original.links){
  let index=published.links.findIndex((p,i)=>!used.has(i)&&(link.anchorUnknown||normalize(p.anchor)===normalize(link.anchor))&&urlKey(p.url)===urlKey(link.url));
  if(index>=0){used.add(index);continue;}
  index=published.links.findIndex((p,i)=>!used.has(i)&&normalize(p.anchor)===normalize(link.anchor));
  if(index>=0){used.add(index);add('超链接','同一锚文本指向的网址已改变',link.anchor+' → '+link.url,published.links[index].anchor+' → '+published.links[index].url);continue;}
  index=published.links.findIndex((p,i)=>!used.has(i)&&urlKey(p.url)===urlKey(link.url));
  if(index>=0){used.add(index);add('锚文本','链接文字已改变',link.anchor,published.links[index].anchor);continue;}
  add('超链接','原稿中的链接未在发布正文中找到',link.anchor+' → '+link.url,'未找到');
 }
 // 媒体自动加的目录锚点（href 指向本文自身）与站内互链不是"新增外部链接"，
 // 逐条列出来会让客户以为文章多了一堆外链——只逐条列真正的外部链接，其余汇总成一行。
 const siteHost=(()=>{try{return new URL(published.url||original.url||'').hostname.replace(/^www\./,'');}catch{return '';}})();
 const sameSite=u=>{try{return siteHost&&new URL(u).hostname.replace(/^www\./,'')===siteHost;}catch{return false;}};
 const leftovers=[];
 for(let i=0;i<published.links.length;i++)if(!used.has(i))leftovers.push(published.links[i]);
 const externalLinks=leftovers.filter(l=>!sameSite(l.url));
 const internalCount=leftovers.length-externalLinks.length;
 externalLinks.slice(0,8).forEach(l=>add('超链接','发布正文新增外部链接','无',l.anchor+' → '+l.url));
 if(externalLinks.length>8)add('超链接',`另有 ${externalLinks.length-8} 个新增外部链接`,'无','见发布正文');
 if(internalCount)add('超链接',`发布正文另有 ${internalCount} 个页内锚点或站内互链`,'无','目录跳转与站内推荐，不是外部品牌链接');
 if(!differences.some(d=>['超链接','锚文本'].includes(d.type)))same.push('锚文本和超链接');
 if(normalize(original.text)!==normalize(published.text)){
 const allOriginals=sentences(original.text),allPosts=sentences(published.text);if(allOriginals.length>200||allPosts.length>200)pending.push('正文较长，本次核对前 200 个段落或句子，其余内容需确认。');
 const originals=allOriginals.slice(0,200),posts=allPosts.slice(0,200),paired=new Set(),edits=[],missing=[],added=[];
 for(const sentence of originals){let best=-1,value=0;for(let i=0;i<posts.length;i++){if(paired.has(i))continue;const s=score(sentence,posts[i]);if(s>value){value=s;best=i;}}
  if(best>=0&&minorChange(sentence,posts[best],protectedWords)){paired.add(best);if(normalize(sentence)!==normalize(posts[best]))ignored++;}
  else if(best>=0&&value>=.45){paired.add(best);edits.push({before:sentence,after:posts[best]});}
  else if(!normalize(published.text).includes(normalize(sentence)))missing.push(sentence);
 }
 for(let i=0;i<posts.length;i++)if(!paired.has(i)&&!normalize(original.text).includes(normalize(posts[i]))&&!isHeadingish(posts[i]))added.push(posts[i]);
 // 同一段落的多句修改合并成一处；整段被删/被加的不逐段罗列，改成一行汇总
 // 媒体常把一段拆成几句，首轮配对会错位；这里让剩余句子再配一次，避免误报"删了 26 处"
 const taken=new Set(),restMissing=[];
 for(const m of missing){
  let best=-1,val=0;
  for(let i=0;i<added.length;i++){if(taken.has(i))continue;const sc=score(m,added[i]);if(sc>val){val=sc;best=i;}}
  if(best>=0&&val>=.3){taken.add(best);edits.push({before:m,after:added[best]});}
  else restMissing.push(m);
 }
 const restAdded=added.filter((_,i)=>!taken.has(i));
 for(const group of clusterPairs(edits))add('正文','正文内容有修改',group.before,group.after);
 if(restMissing.length)add('正文',`原稿有 ${restMissing.length} 处内容未在发布正文中找到`,'可能被编辑改写或删减：'+restMissing.slice(0,4).join(' / '),'未找到对应段落');
 if(restAdded.length)add('正文',`发布文章有 ${restAdded.length} 处新增内容`,'无',restAdded.slice(0,4).join(' / '));
 }
 if(!differences.some(d=>d.type==='正文'))same.push('正文主要内容');
 const matchedImages=new Set();
 for(let i=0;i<original.images.length;i++){const image=original.images[i];let j=published.images.findIndex((p,k)=>!matchedImages.has(k)&&(imageKey(image.url)===imageKey(p.url)||sameImage(image.hash,p.hash)));
  if(j>=0){matchedImages.add(j);continue;}
  if(image.unreadable||published.images.some((p,k)=>!matchedImages.has(k)&&p.unreadable))pending.push(`原稿第 ${i+1} 张图片暂未能核实，不能据此认定被删除或替换。`);
  else add('图片',`原稿第 ${i+1} 张图片未匹配到，可能被删除或替换`,image.alt||`原稿图片 ${i+1}`,image.url?.startsWith('embedded:')?'未匹配到相同图片':image.url||'未匹配');
 }
 const unmatched=published.images.filter((_,i)=>!matchedImages.has(i)&&!published.images[i].unreadable);
 if(unmatched.length&&original.images.every(i=>!i.unreadable)&&!original.imagesUnknown)add('图片',`发布文章有 ${unmatched.length} 张未与原稿匹配的配图`,'原稿未匹配',unmatched.map(x=>x.url).join('\n'));
 if(published.images.some(i=>i.unreadable))pending.push('部分发布图片无法读取，图片内容仍需确认。');
 if(original.imagesUnknown)pending.push('此格式的图片无法完整提取，图片项未能全部核实。');
 if(original.linksUnknown)pending.push('此格式没有完整的超链接标记，链接项可能不完整。');
 if(original.imageLimited||published.imageLimited)pending.push('图片较多，本次仅核对前 16 张。');
 if(!differences.some(d=>d.type==='图片')&&!pending.some(p=>p.includes('图片')))same.push('图片');
 const priority={'标题':0,'锚文本':1,'超链接':2,'图片':3,'正文':4};differences.sort((a,b)=>priority[a.type]-priority[b.type]);
 const counts={differences:differences.length,ignored,pending:pending.length,originalLinks:original.links.length,publishedLinks:published.links.length,originalImages:original.imageCount??original.images.length,publishedImages:published.imageCount??published.images.length};
 return {state:pending.length?'partial':'complete',checkedAt:new Date().toISOString(),summary:makeSummary({differences,ignored,pending,same,counts}),counts,differences:differences.slice(0,30),truncated:differences.length>30,pending,same,rule:'忽略排版、大小写、标点及少量非关键措辞变化；数字、否定语义、标题与链接的实质变化单独列出。',originalTitle:original.title,publishedTitle:published.title};
}
