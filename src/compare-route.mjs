import {Worker} from 'node:worker_threads';
import {randomBytes} from 'node:crypto';
import {validateUrl} from './fetch-public.mjs';
import {withinBudget} from './response-budget.mjs';
import {originAllowed} from './config.mjs';
const jobs=new Map(),rates=new Map();let active=0;
function send(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));}
function snapshot(job){return {pending:!job.done,...(!job.done?{jobId:job.id}:{}),report:job.report,error:job.error};}
export async function handleComparison(req,res){
 const ip=String(req.headers['x-real-ip']||req.socket.remoteAddress),url=new URL(req.url,'http://localhost'),now=Date.now();
 for(const [id,job] of jobs)if(now-job.at>180000)jobs.delete(id);
 if(req.method==='GET'){const job=jobs.get(url.searchParams.get('job'));if(!job||job.ip!==ip)return send(res,404,{error:'比对已过期，请重新提交。'});return send(res,200,snapshot(job));}
 if(req.method!=='POST')return send(res,405,{error:'请在查询页面提交原稿。'});
 if(!originAllowed(req.headers.origin))return send(res,403,{error:'请从本工具的网页发起请求。'});
 if(!String(req.headers['content-type']).startsWith('application/json'))return send(res,415,{error:'请通过页面上传稿件。'});
 for(const [key,rate] of rates)if(now-rate.at>60000)rates.delete(key);
 const rate=rates.get(ip)||{count:0,at:now};if(rate.count>=3||rates.size>2000)return send(res,429,{error:'比对较频繁，请一分钟后重试。'});rate.count++;rates.set(ip,rate);
 if(active>=1)return send(res,503,{error:'当前有稿件正在比对，请稍后重试。'});
 active++;let transferred=false;
 try{
  const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>8500000)return send(res,413,{error:'稿件过大，请上传不超过 6 MB 的文档。'});chunks.push(chunk);}
  let input;try{input=JSON.parse(Buffer.concat(chunks));}catch{return send(res,400,{error:'稿件上传不完整，请重试。'});}
  validateUrl(input.url);if(input.originalUrl)validateUrl(input.originalUrl);
  if(!input.file&&!input.originalUrl)return send(res,400,{error:'请上传原稿，或填写公开的在线文档链接。'});
  if(input.file&&(typeof input.file.data!=='string'||input.file.data.length>8000000))return send(res,413,{error:'请上传不超过 6 MB 的文档。'});
  const job={id:randomBytes(24).toString('base64url'),ip,at:now,done:false};if(jobs.size>=20)jobs.delete(jobs.keys().next().value);jobs.set(job.id,job);
  const worker=new Worker(new URL('./compare-worker.mjs',import.meta.url),{workerData:{url:input.url,originalUrl:input.originalUrl,file:input.file},env:{PATH:process.env.PATH,LANG:'C.UTF-8'},resourceLimits:{maxOldGenerationSizeMb:128}});transferred=true;
  job.work=new Promise(resolve=>{
   let ended=false;const finish=data=>{if(ended)return;ended=true;clearTimeout(timer);Object.assign(job,data,{done:true});active--;resolve();worker.terminate().catch(()=>{});};
   const timer=setTimeout(()=>finish({error:'比对超时，部分媒体或图片可能无法访问，请稍后重试。'}),32000);
   worker.once('message',finish);worker.once('error',()=>finish({error:'暂时无法解析稿件，请另存为 Word 文档后重试。'}));worker.once('exit',()=>{if(!ended)finish({error:'比对未完成，请重新提交。'});});
  });
  await withinBudget(job.work,1500);return send(res,200,snapshot(job));
 }catch(error){return send(res,400,{error:/^请输入|^仅支持|^该地址/.test(error.message)?error.message:'暂时无法读取稿件，请检查文件和在线链接。'});}finally{if(!transferred)active--;}
}
