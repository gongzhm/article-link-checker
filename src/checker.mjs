import robotsParser from 'robots-parser';
import {fetchPublic,validateUrl} from './fetch-public.mjs';
import {analyzeHtml,homepageMatch,comparable} from './analyze.mjs';
import {searchArticleIndex,matchesArticle} from './index-search.mjs';
import {resolveWixArticle} from './wix-article.mjs';
import {captureShots,captureGoogleShot} from './shots.mjs';
const UA='ArticleLinkChecker';
const robotsCache=new Map(),pageCache=new Map(),pagePending=new Map();
const SHOT_TIMEOUT=46000;
async function cachedPage(url,options){
 const key=validateUrl(url).href,saved=pageCache.get(key);
 if(saved&&Date.now()-saved.fetchedAt<300000)return {...saved,cached:true};
 if(pagePending.has(key))return pagePending.get(key);
 const work=fetchPublic(key,options).then(page=>resolveWixArticle(page,options)).then(page=>{
  const result={...page,fetchedAt:Date.now()};
  if(page.status===200&&page.bytes<=500000){if(pageCache.size>=20)pageCache.delete(pageCache.keys().next().value);pageCache.set(key,result);}return result;
 }).finally(()=>pagePending.delete(key));pagePending.set(key,work);return work;
}
export function markResults(result) {
 const expected=[result.requestedUrl,result.finalUrl].filter(Boolean);
 for(const search of [result.siteSearch,result.webSearch])if(search?.items)search.items=search.items.map(item=>({...item,exactMatch:matchesArticle(item.url,expected)}));
 return result;
}

async function allowed(url,signal) {
  try {
    const robotsUrl=new URL('/robots.txt',url).href;
    let saved=robotsCache.get(robotsUrl);
    if(!saved||Date.now()-saved.at>300000){
      const r=await fetchPublic(robotsUrl,{signal,timeout:1500,maxBytes:250000});
      saved={at:Date.now(),parser:r.status===200?robotsParser(robotsUrl,r.body):null};
      if(robotsCache.size>=100)robotsCache.delete(robotsCache.keys().next().value);robotsCache.set(robotsUrl,saved);
    }
    if(saved.parser?.isAllowed(url,UA)===false)return false;
  }catch{}
  return true;
}

const emptyShots=()=>({google:{state:'pending'},homepage:{state:'pending'},section:{state:'pending'},article:{state:'pending'}});
const failShots=note=>({google:{state:'pending'},homepage:{state:'unavailable',note},section:{state:'unavailable',note},article:{state:'unavailable',note}});
/* 谷歌搜索结果页截图走 DataForSEO 异步任务，慢于主流程，后台补齐后再回传 */
function startGoogleShot(result,onUpdate){
 const site=result.siteSearch||{};
 const attempts=site.attempts||[];
 let q='';
 const okQuery=attempts.filter(a=>a.state==='results').map(a=>a.query).pop();
 if(okQuery)q=okQuery;
 else if(site.searchUrl){try{q=new URL(site.searchUrl).searchParams.get('q')||'';}catch{}}
 if(!q&&site.manualSearchUrl){try{q=new URL(site.manualSearchUrl).searchParams.get('q')||'';}catch{}}
 const searchUrl=q?'https://www.google.com/search?hl=en&gl=us&pws=0&q='+encodeURIComponent(q):'';
 if(process.env.SERP_SHOT==='0'||!searchUrl){
  result.shots={...(result.shots||{}),google:{state:'unavailable',note:'未生成谷歌搜索结果页截图。'}};
  onUpdate(result);return;
 }
 captureGoogleShot({searchUrl}).then(shot=>{
  result.shots={...(result.shots||{}),google:shot};
  onUpdate(result);
 }).catch(()=>{
  result.shots={...(result.shots||{}),google:{state:'unavailable',note:'谷歌搜索结果页暂时无法截图。'}};
  onUpdate(result);
 });
}
async function takeShots(payload,result,onUpdate){
 let timer;
 const guard=new Promise(resolve=>{timer=setTimeout(()=>resolve(failShots('截图超时，请稍后重试。')),SHOT_TIMEOUT);});
 try{
  const shots=await Promise.race([
    captureShots(payload,next=>{result.shots={...next,google:result.shots?.google||{state:'pending'}};onUpdate(result);}),
    guard,
  ]);
  result.shots={...shots,google:result.shots?.google||{state:'pending'}};
 }catch(error){
  result.shots={...failShots('截图暂不成功。'),google:result.shots?.google||{state:'pending'}};
 }finally{clearTimeout(timer);onUpdate(result);}
 return result.shots;
}

export async function checkArticle(value,targetDomain='',onUpdate=()=>{}) {
  const url=validateUrl(value).href;const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),22000);const signal=controller.signal;
  const result={requestedUrl:url,checkedAt:new Date().toISOString(),method:'公开页面源 HTML；不执行媒体脚本',targetDomain,readable:false,note:'媒体页面正在读取。',pagePending:true,shots:emptyShots(),siteSearch:{state:'pending',items:[],note:'谷歌查询中'}};
  onUpdate(result);
  const siteUrl=new URL(url);const siteQuery='site:'+siteUrl.hostname+siteUrl.pathname+siteUrl.search;
  const siteTask=searchArticleIndex(url,{signal,context:()=>({finalUrl:result.finalUrl,title:result.analysis?.title}),onUpdate:v=>{result.siteSearch=v;markResults(result);}}).then(v=>{result.siteSearch=v;markResults(result);return v;});
  try {
    let page;
    try {
      if(!await allowed(url,signal))throw Error('该网站禁止此工具抓取，无法读取页面。');
      page=await cachedPage(url,{signal});
    }catch(error){
      if(error.message.startsWith('该地址不是'))throw error;
      result.pagePending=false;result.readable=false;result.finalUrl=url;result.httpStatus=null;result.redirects=[];
      result.note=error.message.startsWith('该网站')?error.message:'媒体连接未完成，本次仅返回可获取的搜索结果。';
      result.siteSearch=await siteTask;
      result.shots=failShots('文章页面未能读取，未生成截图。');
      startGoogleShot(result,onUpdate);
      return markResults(result);
    }
    result.pagePending=false;result.finalUrl=page.url;result.httpStatus=page.status;result.redirects=page.redirects;
    const challenge=/just a moment|checking your browser|enable javascript and cookies|verify you are human|attention required.{0,50}cloudflare/i.test(page.body.slice(0,30000));
    const html=(!page.headers['content-type']||/html/i.test(page.headers['content-type']))&&/<(?:html|head|body|article|main)\b/i.test(page.body);
    result.readable=page.status>=200&&page.status<300&&!challenge&&html;
    if(result.readable)delete result.note;
    if(!result.readable)result.note=challenge?'媒体要求浏览器验证，无法读取文章。':page.status>=400?`媒体返回 HTTP ${page.status}，本次未解析正文。`:'返回内容不是可解析的文章网页。';
    if(result.readable) {
      result.analysis=analyzeHtml(page,targetDomain);result.pageFetchedAt=new Date(page.fetchedAt).toISOString();result.pageCached=!!page.cached;
      const home=new URL('/',page.url).href;
      result.homepage={url:home,state:'pending',matches:[]};
      const homepageTask=(async()=>{
        try {
          if(!await allowed(home,signal))throw Error('抓取受限');
          const hp=await cachedPage(home,{signal,timeout:4500});
          if(hp.status!==200||/just a moment|checking your browser|verify you are human/i.test(hp.body.slice(0,20000)))throw Error('受限');
          const matches=homepageMatch(hp,page.url);result.homepage={url:hp.url,state:matches.length?'found':'not_found',matches,note:matches.length?'首页源 HTML 中发现文章链接。':'本次首页源 HTML 未发现该链接，动态区块及历史位置未核实。'};
        }catch{result.homepage.state='unknown';result.homepage.note='媒体首页暂时无法读取，不能判断是否展示。';}
      })();
      const site=await Promise.all([siteTask,homepageTask]).then(([s])=>s);
      site.items=site.items.map(item=>({...item,exactMatch:matchesArticle(item.url,[url,page.url])}));
      result.siteSearch=site;
      await takeShots({articleUrl:page.url,articleHtml:page.body,sectionName:result.analysis?.section?.name||'',homepageUrl:result.homepage?.url||home},result,onUpdate);
      startGoogleShot(result,onUpdate);
      if(result.shots?.homepage?.found&&result.homepage&&result.homepage.state!=='found'){
        result.homepage.state='found';
        result.homepage.matches=[{anchor:String(result.shots.homepage.found).slice(0,150),url:page.url,source:'browser'}];
        result.homepage.note='首页浏览器渲染复核发现本文入口。';
      }
    } else {
      result.siteSearch=await siteTask;
      result.shots=failShots('文章页面无法解析，未生成截图。');
      startGoogleShot(result,onUpdate);
    }
    return markResults(result);
  }finally{clearTimeout(timer);}
}
