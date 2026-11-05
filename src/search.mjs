import fs from 'node:fs';
import path from 'node:path';
import {webUrl} from './analyze.mjs';
const cache=new Map(),inflight=new Map();
const stateFile=process.env.CHECKER_USAGE_FILE;
const cacheFile=stateFile?path.join(path.dirname(stateFile),'search-cache.json'):null;
try{if(cacheFile)for(const [q,v] of JSON.parse(fs.readFileSync(cacheFile,'utf8')))if(Date.now()-v.at<21600000&&['results','no_results'].includes(v.data?.state))cache.set(q.startsWith('[')?q:JSON.stringify(['organic',q]),{...v,data:{...v.data,kind:v.data.kind||'organic',items:(v.data.items||[]).slice(0,5)}});}catch{}
function remember(query,data){
 if(cache.size>=200)cache.delete(cache.keys().next().value);cache.set(query,{at:Date.now(),data});
 if(cacheFile){try{fs.writeFileSync(cacheFile+'.tmp',JSON.stringify([...cache]),{mode:0o600});fs.renameSync(cacheFile+'.tmp',cacheFile);}catch{}}
}
let usage={day:new Date().toISOString().slice(0,10),queries:0,cost:0};
try{if(stateFile)usage=JSON.parse(fs.readFileSync(stateFile,'utf8'));}catch{}
function save(){if(stateFile){fs.writeFileSync(stateFile+'.tmp',JSON.stringify(usage),{mode:0o600});fs.renameSync(stateFile+'.tmp',stateFile);}}
export async function searchGoogle(query,options={}){
 const kind=options.kind==='news'?'news':'organic',cacheKey=JSON.stringify([kind==='organic'?'organic-v2':kind,query]);
 if(inflight.has(cacheKey))return inflight.get(cacheKey);
 const work=performSearch(query,{...options,kind,cacheKey}).finally(()=>inflight.delete(cacheKey));inflight.set(cacheKey,work);return work;
}
// Maintenance-only import of a result actually observed on Google. No public
// endpoint accepts these records. Keep the origin and observation time visible.
export function saveGoogleVerification(query,items){
 const checkedAt=new Date().toISOString();
 const rows=items.map(x=>({...x,url:webUrl(x.url)})).filter(x=>x.url).slice(0,5);
 if(!rows.length)throw Error('No verified Google results');
 const data={query,kind:'organic',source:'Google 网页复核',manualVerified:true,region:'美国 · 英语 · 网页复核',checkedAt,state:'results',items:rows,searchUrl:'https://www.google.com/search?hl=en&gl=us&pws=0&q='+encodeURIComponent(query),note:'已通过谷歌网页复核，展示已保存结果。'};
 remember(JSON.stringify(['organic-v2',query]),data);return data;
}
export function searchItems(serp,kind){
 const rows=[];
 for(const item of serp.items||[]){
  if(kind==='news'){
   if(item.type==='news_search')rows.push(item);
   else if(item.type==='top_stories')rows.push(...(item.items||[]).filter(x=>x.type==='top_stories_element'));
  }else if(item.type==='organic')rows.push(item);
 }
 const seen=new Set();return rows.filter(x=>{const url=webUrl(x.url);if(!url||seen.has(url))return false;seen.add(url);return true;}).slice(0,5).map(x=>({title:String(x.title||x.url).slice(0,300),url:webUrl(x.url),snippet:String(x.snippet||x.description||'').slice(0,500),rank:x.rank_group,publishedAt:x.timestamp||x.time_published||x.date||null}));
}
async function performSearch(query,{signal,kind='organic',cacheKey,timeoutMs}={}) {
 const common={query,kind,source:'Google · DataForSEO',region:'美国 · 英语 · 桌面端',checkedAt:new Date().toISOString(),searchUrl:'https://www.google.com/search?hl=en&gl=us&pws=0&'+(kind==='news'?'tbm=nws&':'')+'q='+encodeURIComponent(query)};
 if(!process.env.DATAFORSEO_AUTH)return {...common,state:'unavailable',items:[],note:'谷歌检索服务暂不可用，可打开原始查询复核。'};
 if(query.length>700)return {...common,state:'unavailable',items:[],note:'查询内容超过搜索接口的长度限制。'};
 const saved=cache.get(cacheKey);if(saved&&Date.now()-saved.at<(saved.data.state==='no_results'?120000:900000))return {...saved.data,cached:true};
 const previousPositive=()=>saved?.data.state==='results'&&Date.now()-saved.at<21600000?{...saved.data,cached:true,stale:true,note:'本次接口未能确认，展示上次成功查询记录，请核对查询时间。'}:null;
 try {
  const day=new Date().toISOString().slice(0,10);if(usage.day!==day)usage={day,queries:0,cost:0};
  if(usage.queries>=Number(process.env.CHECKER_DAILY_SEARCH_LIMIT||200))return {...common,state:'unavailable',items:[],note:'今日检索额度已用完，请稍后再试。'};
  let data,response,task;
  for(let attempt=0;attempt<2;attempt++) {
   if(usage.queries>=Number(process.env.CHECKER_DAILY_SEARCH_LIMIT||200))throw Error('limit');
   usage.queries++;save();
   try {
    response=await fetch('https://api.dataforseo.com/v3/serp/google/'+(kind==='news'?'news/live/advanced':'organic/live/'+(attempt?'advanced':'regular')),{
     method:'POST',headers:{Authorization:'Basic '+process.env.DATAFORSEO_AUTH,'Content-Type':'application/json'},
     body:JSON.stringify([{keyword:query.replace(/%/g,'%25').replace(/\+/g,'%2B'),location_code:2840,language_code:'en',device:'desktop',depth:10,max_crawl_pages:1,...(kind==='news'?{}:{search_param:'pws=0&filter=0'})}]),
     signal:AbortSignal.any([signal||new AbortController().signal,AbortSignal.timeout(timeoutMs?Math.min(timeoutMs,attempt?4000:6000):(attempt?7000:10000))])
    });
    data=await response.json();task=data.tasks?.[0];
    usage.cost+=Number(data.cost)||0;save();
    if(attempt===0&&[40101,40103].includes(task?.status_code))continue;
    break;
   }catch(error){if(attempt===1||signal?.aborted)throw error;}
  }
  if(data.status_code===40102||task?.status_code===40102){const old=previousPositive();if(old)return old;const empty={...common,state:'no_results',items:[],note:'本次查询未返回匹配文章，不能据此判断未收录。'};remember(cacheKey,empty);return empty;}
  if(!response.ok) {console.warn('Search provider status',response.status,data.status_code,task?.status_code);throw Error('provider');}
  console.log('Search task status',data.status_code,task?.status_code);
  if(data.status_code!==20000||task?.status_code!==20000||!Array.isArray(task.result)||!task.result.length)throw Error('provider');
  const serp=task.result[0];if(!Array.isArray(serp.items)&&serp.items!==null)throw Error('provider');
  const items=searchItems(serp,kind);
  if(!items.length){const old=previousPositive();if(old)return old;}
  const checkUrl=webUrl(serp.check_url);
  const result={...common,...(checkUrl&&/(^|\.)google\.[a-z.]+$/.test(new URL(checkUrl).hostname)&&(kind!=='news'||new URL(checkUrl).searchParams.get('tbm')==='nws'||new URL(checkUrl).hostname==='news.google.com')?{searchUrl:checkUrl}:{}),state:items.length?'results':'no_results',items,note:items.length?'本次谷歌查询结果。':'本次查询未返回匹配文章，不能据此判断未收录。'};
  remember(cacheKey,result);
  return result;
 }catch(error){if(saved?.data.state==='results'&&Date.now()-saved.at<21600000)return {...saved.data,cached:true,stale:true,note:'实时查询暂未完成，展示最近一次成功查询，时间见下方。'};console.warn('Search unavailable',error.name,error.cause?.code||'');return {...common,state:'unavailable',items:[],note:'谷歌检索暂未成功，请稍后重试或打开原始查询复核。'};}
}
