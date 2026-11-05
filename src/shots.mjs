import puppeteer from 'puppeteer';
import {load} from 'cheerio';
import {randomBytes} from 'node:crypto';
import {existsSync} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {SHOT_DIR as CONFIG_SHOT_DIR, PROFILE_DIR as CONFIG_PROFILE_DIR} from './config.mjs';

async function shellPath(){
  if(process.env.CHROME_SHELL&&existsSync(process.env.CHROME_SHELL))return process.env.CHROME_SHELL;
  const root=process.env.PUPPETEER_CACHE_DIR||path.join(process.cwd(),'.puppeteer');
  const dir=path.join(root,'chrome-headless-shell');
  try{
    const versions=(await fs.readdir(dir)).sort().reverse();
    for(const version of versions){
      const candidate=path.join(dir,version,'chrome-headless-shell-linux64','chrome-headless-shell');
      if(existsSync(candidate))return candidate;
    }
  }catch{}
  return undefined;
}

const WIDTH=1500,HEIGHT=1000;
const SHOT_DIR=CONFIG_SHOT_DIR;
const PROFILE_DIR=CONFIG_PROFILE_DIR;
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BLOCK=/googletagmanager|google-analytics|doubleclick|facebook\.net|hotjar|segment\.|criteo|taboola|outbrain|adservice|scorecardresearch|quantserve/i;

let browserPromise=null,active=0,idleTimer=null,queue=Promise.resolve();

async function launch(){
  if(!browserPromise){
    const executablePath=await shellPath();
    browserPromise=puppeteer.launch({
    headless:'shell',
    ...(executablePath?{executablePath}:{}),
    args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-extensions','--disable-background-networking','--no-first-run','--no-default-browser-check','--lang=en-US','--hide-scrollbars','--mute-audio','--font-render-hinting=none'],
    defaultViewport:{width:WIDTH,height:HEIGHT,deviceScaleFactor:1},
    userDataDir:PROFILE_DIR,
    protocolTimeout:45000,
  }).then(b=>{b.on('disconnected',()=>{browserPromise=null;});return b;});}
  return browserPromise;
}
function scheduleIdleClose(){
  clearTimeout(idleTimer);
  idleTimer=setTimeout(async()=>{
    if(active>0||!browserPromise)return;
    const b=browserPromise;browserPromise=null;
    try{await b.close();}catch{}
  },90000);
  idleTimer.unref?.();
}
function serial(task){
  const run=queue.then(async()=>{
    active++;
    try{return await task();}finally{active--;scheduleIdleClose();}
  });
  queue=run.catch(()=>{});
  return run;
}

const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function dismissConsent(page){
  try{
    await page.evaluate(()=>{
      const words=/^(accept( all)?|i agree|agree|got it|ok(ay)?|同意|接受|我知道了|允许全部)$/i;
      const nodes=[...document.querySelectorAll('button,a,[role="button"],input[type="button"]')];
      for(const el of nodes){
        const text=(el.innerText||el.value||'').trim();
        if(!text||text.length>24||!words.test(text))continue;
        const box=el.getBoundingClientRect();
        if(box.width<8||box.height<8)continue;
        el.click();return true;
      }
      return false;
    });
  }catch{}
}

function sameHost(a,b){
  try{const x=new URL(a),y=new URL(b);return x.hostname.replace(/^www\./,'')===y.hostname.replace(/^www\./,'');}catch{return false;}
}

export function sectionCandidate(articleUrl,html,sectionName){
  const base=articleUrl;
  let candidates=[];
  try{
    const $=load(html||'');
    const scope=$('.breadcrumb a[href],.breadcrumbs a[href],[class*="breadcrumb"] a[href],[aria-label*="readcrumb" i] a[href],[aria-label*="面包屑"] a[href]');
    scope.each((_,el)=>{
      const href=$(el).attr('href');
      try{const u=new URL(href,base);u.hash='';if(sameHost(u.href,base)&&u.pathname.replace(/\/$/,'')!==new URL(base).pathname.replace(/\/$/,'')&&u.pathname.replace(/\//g,'').length)if(!candidates.includes(u.href))candidates.push(u.href);}catch{}
    });
    if(sectionName){
      const want=sectionName.toLowerCase().trim();
      $('a[href]').each((_,el)=>{
        if(candidates.length>8)return;
        const text=$(el).text().replace(/\s+/g,' ').trim().toLowerCase();
        if(!text||text!==want)return;
        const href=$(el).attr('href');
        try{const u=new URL(href,base);u.hash='';if(sameHost(u.href,base)&&u.pathname.replace(/\/$/,'')!==new URL(base).pathname.replace(/\/$/,''))if(!candidates.includes(u.href))candidates.push(u.href);}catch{}
      });
    }
  }catch{}
  if(candidates.length){
    const articlePath=new URL(base).pathname.replace(/\/$/,'');
    const pick=candidates.filter(u=>new URL(u).pathname.replace(/\/$/,'')!==articlePath);
    if(pick.length)return pick[pick.length-1];
  }
  const u=new URL(base),segments=u.pathname.split('/').filter(Boolean);
  if(segments.length>=2&&!/^\d{4}$/.test(segments[0])&&!/^(p|post|article|news|blog)$/i.test(segments[0]))return new URL('/'+segments[0]+'/',u.href).href;
  return null;
}

async function capture(context,{url,label,scrollToArticle=false,matchPath='',timeout=12000}){
  const page=await context.newPage();
  try{
    await page.setUserAgent(UA);
    await page.setExtraHTTPHeaders({'Accept-Language':'en-US,en;q=0.9'});
    await page.setRequestInterception(true);
    page.on('request',req=>{
      const type=req.resourceType();
      if(type==='media'||BLOCK.test(req.url()))return req.abort().catch(()=>{});
      return req.continue().catch(()=>{});
    });
    await page.goto(url,{waitUntil:'domcontentloaded',timeout});
    await sleep(900);
    await dismissConsent(page);
    // 只认「指向本文路径」的链接。以前是拿首页自己的地址去比，
    // 于是 href="/" 或 href="#" 这类站内链接（例如 Skip to content）必然命中，
    // 任何文章都会显示「首页发现本文入口」——误报。
    let found=null;
    if(scrollToArticle&&matchPath){
      found=await page.evaluate(target=>{
        const want=String(target||'').replace(/\/+$/,'').toLowerCase();
        if(want.length<2)return null;
        for(const a of document.querySelectorAll('a[href]')){
          let href=a.href||'';
          if(!href||/^(javascript|mailto|tel):/i.test(href))continue;
          let path;try{path=new URL(href,location.href).pathname.replace(/\/+$/,'').toLowerCase();}catch{continue;}
          if(path!==want)continue;
          const text=(a.innerText||'').replace(/\s+/g,' ').trim();
          if(/^skip to\b/i.test(text))continue;
          const box=a.getBoundingClientRect();
          if(!box.width||!box.height)continue;
          a.scrollIntoView({block:'center'});
          return text.slice(0,120)||'（图片或卡片链接）';
        }
        return null;
      },matchPath).catch(()=>null);
      if(found)await sleep(700);
    }
    try{await page.evaluate(()=>{document.querySelectorAll('[class*="cookie"],[id*="cookie"],[class*="consent"]').forEach(el=>{const s=getComputedStyle(el);if(s.position==='fixed'||s.position==='sticky'){const b=el.getBoundingClientRect();if(b.height>window.innerHeight*0.4)return;if(b.bottom>window.innerHeight-2&&b.top>window.innerHeight*0.55)el.style.display='none';}});});}catch{}
    await sleep(400);
    await fs.mkdir(SHOT_DIR,{recursive:true});
    const name=randomBytes(16).toString('hex')+'.jpg';
    const file=path.join(SHOT_DIR,name);
    const buffer=await page.screenshot({type:'jpeg',quality:92,optimizeForSpeed:true});
    await fs.writeFile(file,buffer);
    return {state:'ok',url:page.url()||url,label,src:'/api/article-shot/'+name,width:WIDTH,height:HEIGHT,found};
  }finally{await page.close().catch(()=>{});}
}

export async function captureShots({articleUrl,articleHtml,sectionName,homepageUrl},onShot=()=>{}){
  let articlePath='';try{articlePath=new URL(articleUrl).pathname;}catch{}
  const shots={homepage:{state:'pending'},section:{state:'pending'},article:{state:'pending'}};
  const emit=()=>{onShot(shots);};
  const runSerial=task=>serial(task);
  const fail=(key,note)=>{shots[key]={state:'unavailable',note};emit();};
  try{
    const browser=await launch();
    const context=await browser.createBrowserContext();
    try{
      /* 文章正文最关键，先拍：避免首页/栏目页耗时把正文挤出总时限 */
      try{
        shots.article=await runSerial(()=>capture(context,{url:articleUrl,label:'文章正文'}));
        shots.article.note='文章发布页面首屏。';
      }catch{fail('article','文章页面暂时无法截图，可能存在访问限制。');}
      emit();
      if(homepageUrl){
        try{
          shots.homepage=await runSerial(()=>capture(context,{url:homepageUrl,label:'媒体首页',scrollToArticle:true,matchPath:articlePath}));
          shots.homepage.note=shots.homepage.found?`首页发现本文入口（${shots.homepage.found}）。`:'首页首屏未见本文入口。';
        }catch{fail('homepage','媒体首页暂时无法截图，可能存在访问限制。');}
      }else{fail('homepage','未识别到媒体首页地址。');}
      emit();
      const sectionUrl=sectionCandidate(articleUrl,articleHtml,sectionName);
      if(sectionUrl){
        try{
          shots.section=await runSerial(()=>capture(context,{url:sectionUrl,label:'频道栏目页'}));
          shots.section.note='文章所属频道栏目页首屏。';
        }catch{fail('section','频道栏目页暂时无法截图，可能存在访问限制。');}
      }else{fail('section','未识别到文章所属频道栏目页。');}
      emit();
    }finally{await context.close().catch(()=>{});}
  }catch(error){
    for(const key of ['homepage','section','article'])if(shots[key].state==='pending')shots[key]={state:'unavailable',note:'截图组件暂不可用。'};
    emit();
  }
  return shots;
}

/* ---------- 谷歌搜索结果页截图（走 DataForSEO，服务端不直连 Google） ---------- */
const SERP_API = 'https://api.dataforseo.com';
const SERP_TIMEOUT = Number(process.env.SERP_SHOT_TIMEOUT || 70000);

function serpHeaders(auth) {
  return { Authorization: 'Basic ' + auth, 'Content-Type': 'application/json' };
}

async function createSerpTask(auth, searchUrl) {
  let keyword = '';
  try { keyword = new URL(searchUrl).searchParams.get('q') || ''; } catch {}
  if (!keyword) return null;
  const res = await fetch(SERP_API + '/v3/serp/google/organic/task_post', {
    method: 'POST',
    headers: serpHeaders(auth),
    body: JSON.stringify([{ keyword, location_code: 2840, language_code: 'en', device: 'desktop', os: 'windows', depth: 10 }]),
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => null);
  return json?.tasks?.[0]?.id || null;
}

async function waitSerpTask(auth, taskId, deadline) {
  while (Date.now() < deadline) {
    await sleep(3000);
    const res = await fetch(SERP_API + '/v3/serp/google/organic/task_get/advanced/' + taskId, {
      headers: { Authorization: 'Basic ' + auth },
      signal: AbortSignal.timeout(15000),
    });
    const json = await res.json().catch(() => null);
    const code = json?.tasks?.[0]?.status_code;
    if (code === 20000) return true;
    if (code && ![40601, 40602, 40603, 40101].includes(code)) return false;
  }
  return false;
}

async function requestSerpScreenshot(auth, taskId) {
  const res = await fetch(SERP_API + '/v3/serp/screenshot', {
    method: 'POST',
    headers: serpHeaders(auth),
    body: JSON.stringify([{
      task_id: taskId,
      browser_preset: 'desktop',
      browser_screen_width: WIDTH,
      browser_screen_height: HEIGHT,
      browser_screen_scale_factor: 1,
      page: 1,
    }]),
    signal: AbortSignal.timeout(30000),
  });
  const json = await res.json().catch(() => null);
  return json?.tasks?.[0]?.result?.[0]?.items?.[0]?.image || null;
}

/* 把 DataForSEO 返回的整页长图裁成 1200×800（3:2）JPEG，复用同一个无头浏览器 */
async function cropToShot(buffer, mime = 'image/png') {
  return serial(async () => {
    const browser = await launch();
    const context = await browser.createBrowserContext();
    try {
      const page = await context.newPage();
      await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });
      const dataUrl = 'data:' + mime + ';base64,' + buffer.toString('base64');
      await page.setContent(
        '<style>html,body{margin:0;padding:0;overflow:hidden;background:#fff}img{display:block;width:' + WIDTH + 'px;height:auto}</style><img src="' + dataUrl + '">',
        { waitUntil: 'load', timeout: 20000 }
      );
      return await page.screenshot({ type: 'jpeg', quality: 80, optimizeForSpeed: true, clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } });
    } finally { await context.close().catch(() => {}); }
  });
}

export async function captureGoogleShot({ searchUrl } = {}) {
  const auth = process.env.DATAFORSEO_AUTH;
  if (!auth || !searchUrl) return { state: 'unavailable', note: '谷歌搜索结果页截图未生成。' };
  const deadline = Date.now() + SERP_TIMEOUT;
  try {
    const taskId = await createSerpTask(auth, searchUrl);
    if (!taskId) return { state: 'unavailable', note: '谷歌搜索结果页截图未生成。' };
    const ready = await waitSerpTask(auth, taskId, Math.min(deadline, Date.now() + 60000));
    if (!ready) return { state: 'unavailable', note: '谷歌搜索结果页生成超时。' };
    const imageUrl = await requestSerpScreenshot(auth, taskId);
    if (!imageUrl) return { state: 'unavailable', note: '谷歌搜索结果页生成超时。' };
    const image = await fetch(imageUrl, { signal: AbortSignal.timeout(25000) });
    if (!image.ok) throw new Error('image ' + image.status);
    const raw = Buffer.from(await image.arrayBuffer());
    const mime = (image.headers.get('content-type') || 'image/png').split(';')[0];
    const buffer = await cropToShot(raw, mime);
    await fs.mkdir(SHOT_DIR, { recursive: true });
    const name = randomBytes(16).toString('hex') + '.jpg';
    await fs.writeFile(path.join(SHOT_DIR, name), buffer);
    return { state: 'ok', src: '/api/article-shot/' + name, url: searchUrl, label: '谷歌搜索结果页', note: '谷歌搜索结果页画面，含本文在搜索结果中的位置。' };
  } catch {
    return { state: 'unavailable', note: '谷歌搜索结果页暂时无法截图。' };
  }
}

export async function cleanupOldShots(maxAgeMs=3600000){
  try{
    const files=await fs.readdir(SHOT_DIR);
    const now=Date.now();
    for(const f of files){
      const full=path.join(SHOT_DIR,f);
      const stat=await fs.stat(full).catch(()=>null);
      if(stat&&now-stat.mtimeMs>maxAgeMs)await fs.unlink(full).catch(()=>{});
    }
  }catch{}
}
