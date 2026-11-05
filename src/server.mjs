import {handleComparison} from './compare-route.mjs';
import {buildExportBundle} from './report-export.mjs';
import {randomBytes} from 'node:crypto';
import {withinBudget} from './response-budget.mjs';
import {cleanupOldShots} from './shots.mjs';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {checkArticle} from './checker.mjs';
import {validateUrl} from './fetch-public.mjs';
import {SHOT_DIR as CONFIG_SHOT_DIR, originAllowed} from './config.mjs';
import {readFile} from 'node:fs/promises';
const cache=new Map(),rates=new Map(),jobs=new Map(),inflight=new Map();let active=0;
const SHOT_DIR=CONFIG_SHOT_DIR;
const PUBLIC_DIR=process.env.PUBLIC_DIR||path.join(process.cwd(),'public');
const SHOT_NAME=/^[a-f0-9]{32}\.jpg$/;
const shotsPending=shots=>Object.values(shots||{}).some(shot=>shot?.state==='pending');
function snapshot(job){
 const pending=!job.done||shotsPending(job.data.shots);
 return {...job.data,pending,jobId:job.id,elapsedMs:Date.now()-job.at};
}
function send(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));}
function sendShot(res,name){
 fs.readFile(path.join(SHOT_DIR,name),(error,buffer)=>{
  if(error)return send(res,404,{error:'截图已过期，请重新查询。'});
  res.writeHead(200,{'Content-Type':'image/jpeg','Content-Length':buffer.length,'Cache-Control':'private, max-age=1800','X-Content-Type-Options':'nosniff'});
  res.end(buffer);
 });
}
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.ico':'image/x-icon','.json':'application/json; charset=utf-8'};
async function serveStatic(res,pathname){
 const rel=pathname==='/'?'index.html':decodeURIComponent(pathname).replace(/^\/+/, '');
 if(rel.includes('..'))return send(res,404,{error:'Not found'});
 try{
  const file=await readFile(path.join(PUBLIC_DIR,rel));
  res.writeHead(200,{'Content-Type':MIME[path.extname(rel).toLowerCase()]||'application/octet-stream','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});
  res.end(file);
 }catch{send(res,404,{error:'Not found'});}
}
setInterval(()=>cleanupOldShots(3600000),900000).unref();
const server=http.createServer(async(req,res)=>{
 if(req.url==='/health'&&req.method==='GET')return send(res,200,{ok:true});
 const requestUrl=new URL(req.url,'http://localhost');
 if(requestUrl.pathname.startsWith('/api/article-shot/')){
  const name=requestUrl.pathname.slice('/api/article-shot/'.length);
  if(req.method!=='GET'||!SHOT_NAME.test(name))return send(res,404,{error:'截图不存在。'});
  return sendShot(res,name);
 }
 if(requestUrl.pathname==='/api/article-compare')return handleComparison(req,res);
 if(requestUrl.pathname==='/api/article-report'){
  if(req.method!=='POST')return send(res,405,{error:'请通过查询页面导出报告。'});
  if(!originAllowed(req.headers.origin))return send(res,403,{error:'请从本工具的网页发起请求。'});
  try{
   const chunks=[];let bytes=0;
   for await(const chunk of req){bytes+=chunk.length;if(bytes>16*1024*1024)return send(res,413,{error:'报告内容过大，请稍后重试。'});chunks.push(chunk);}
   let input;try{input=JSON.parse(Buffer.concat(chunks));}catch{return send(res,400,{error:'报告数据不完整，请重新查询后再试。'});}
   const bundle=await buildExportBundle({html:String(input.html||''),meta:input.meta||{},comparison:input.comparison||null,shots:Array.isArray(input.shots)?input.shots:[]});
   const name=encodeURIComponent(bundle.htmlName.replace(/\.html$/,'.zip'));
   res.writeHead(200,{'Content-Type':'application/zip','Content-Length':bundle.buffer.length,'Content-Disposition':`attachment; filename="article-check-report.zip"; filename*=UTF-8''${name}`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
   return res.end(bundle.buffer);
  }catch(error){return send(res,500,{error:'报告打包失败，请稍后重试。'});}
 }
 if(!requestUrl.pathname.startsWith('/api/'))return serveStatic(res,requestUrl.pathname);
 if(requestUrl.pathname!=='/api/article-check')return send(res,404,{error:'接口不存在。'});
 if(req.method==='GET'){
  const job=jobs.get(requestUrl.searchParams.get('job'));
  if(!job||Date.now()-job.at>120000)return send(res,404,{error:'查询已过期，请重新提交。'});
  return send(res,200,snapshot(job));
 }
 if(req.method!=='POST')return send(res,405,{error:'请通过查询页面提交链接。'});
 if(!originAllowed(req.headers.origin))return send(res,403,{error:'请从本工具的网页发起请求。'});
 if(!String(req.headers['content-type']).startsWith('application/json'))return send(res,415,{error:'提交格式有误。'});
 const now=Date.now();for(const [key,v]of rates)if(now-v.at>60000)rates.delete(key);
 const ip=String(req.headers['x-real-ip']||req.socket.remoteAddress);const rate=rates.get(ip)||{at:now,count:0};
 if(rate.count>=6||rates.size>5000)return send(res,429,{error:'查询较频繁，请一分钟后重试。'});rate.count++;rates.set(ip,rate);
 try {
  let bytes=0;const chunks=[];
  for await(const chunk of req){bytes+=chunk.length;if(bytes>8192)return send(res,413,{error:'提交内容过长。'});chunks.push(chunk);}
  let input;try{input=JSON.parse(Buffer.concat(chunks));}catch{return send(res,400,{error:'提交内容有误。'});}
  const url=validateUrl(input.url).href;let targetDomain='';
  if(input.targetDomain){try{const raw=String(input.targetDomain).trim();targetDomain=validateUrl(/^https?:\/\//i.test(raw)?raw:'https://'+raw).hostname.replace(/^www\./,'');}catch{return send(res,400,{error:'品牌域名格式有误，例如 yourbrand.com。'});}}
  const key=JSON.stringify([url,targetDomain]);const saved=cache.get(key);
  if(saved&&now-saved.at<(saved.data.siteSearch?.state==='unavailable'?5000:120000))return send(res,200,{...saved.data,cached:true});
  for(const [id,j] of jobs)if(now-j.at>120000)jobs.delete(id);
  if(jobs.size>=100){for(const [id,j] of jobs){if(j.done){jobs.delete(id);break;}}}
  let job=inflight.get(key);
  if(!job){
   if(active>=3)return send(res,503,{error:'当前查询较多，请稍后重试。'});
   active++;job={id:randomBytes(24).toString('base64url'),at:Date.now(),done:false,data:{requestedUrl:url,targetDomain,checkedAt:new Date().toISOString(),pagePending:true,readable:false}};
   jobs.set(job.id,job);inflight.set(key,job);
   job.work=checkArticle(url,targetDomain,data=>{job.data=data;}).then(data=>{
    job.data=data;if(cache.size>=100)cache.delete(cache.keys().next().value);cache.set(key,{at:Date.now(),data});
   }).catch(()=>{job.data={...job.data,pagePending:false,note:'本次检测未完成，请重新查询。',siteSearch:{state:'unavailable',items:[],note:'查询未完成'},shots:{google:{state:'unavailable',note:'查询未完成。'},homepage:{state:'unavailable',note:'查询未完成。'},section:{state:'unavailable',note:'查询未完成。'},article:{state:'unavailable',note:'查询未完成。'}}};}).finally(()=>{job.done=true;active--;inflight.delete(key);});
  }
  await withinBudget(job.work,2800);
  send(res,200,snapshot(job));
 }catch(error){const allowed=/^(请输入|仅支持|该地址|该链接|页面体积|媒体|域名解析|检测超时|该网站)/.test(error.message);send(res,400,{error:allowed?error.message:'暂时无法读取该网页，可能存在访问限制或连接失败。'});}
});
server.requestTimeout=35000;server.headersTimeout=10000;
const PORT=Number(process.env.PORT||3003),HOST=process.env.HOST||'127.0.0.1';
server.listen(PORT,HOST,()=>console.log(`Article link checker ready on http://${HOST}:${PORT}`));
