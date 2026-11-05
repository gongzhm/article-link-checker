import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import ipaddr from 'ipaddr.js';
import {gunzipSync,inflateSync,brotliDecompressSync} from 'node:zlib';
const agents={ 'http:':new http.Agent({keepAlive:true,maxSockets:6,maxFreeSockets:3,timeout:10000}), 'https:':new https.Agent({keepAlive:true,maxSockets:6,maxFreeSockets:3,timeout:10000})};
export function decodeBody(buffer,encoding='',maxBytes=2000000){
 const options={maxOutputLength:maxBytes};
 const decoded=encoding==='gzip'?gunzipSync(buffer,options):encoding==='deflate'?inflateSync(buffer,options):encoding==='br'?brotliDecompressSync(buffer,options):!encoding||encoding==='identity'?buffer:null;
 if(!decoded||decoded.length>maxBytes)throw Error('页面体积超过检测上限或压缩格式不受支持。');return decoded;
}

export function publicAddress(address) {
  try { return ipaddr.process(address).range()==='unicast'; } catch { return false; }
}
export function validateUrl(value) {
  let url;
  try { url=new URL(value); } catch { throw Error('请输入完整的 http 或 https 链接。'); }
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.port||url.href.length>2048)
    throw Error('仅支持不含账号密码、使用标准端口的公开网页链接。');
  const host=url.hostname.toLowerCase();
  if(!host.includes('.')||host.endsWith('.')||/\.(localhost|local|internal|test|invalid|example)$/.test(host)||host==='localhost'||ipaddr.isValid(host.replace(/^\[|\]$/g,'')))
    throw Error('仅支持公开网站域名，不支持 IP、内网或本地域名。');
  url.hash='';
  return url;
}

export async function fetchPublic(value,{signal,timeout=9000,maxBytes=2000000,binary=false,authorization}={}) {
  let url=validateUrl(value);
  const authOrigin=url.origin;
  const redirects=[];
  for(let hop=0;hop<=4;hop++) {
    if(signal?.aborted) throw Error('检测超时，请稍后重试。');
    const addresses=await Promise.race([
      dns.lookup(url.hostname,{all:true,verbatim:true}),
      new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('域名解析超时。')),4000);t.unref();})
    ]);
    if(!addresses.length||addresses.some(a=>!publicAddress(a.address))) throw Error('该地址不是可检测的公开网站。');
    const pinned=addresses[0];
    const page=await new Promise((resolve,reject)=>{
      const client=url.protocol==='https:'?https:http;
      const req=client.get(url,{
        agent:agents[url.protocol],signal,
        lookup:(_host,options,callback)=>options.all?callback(null,[pinned]):callback(null,pinned.address,pinned.family),
        headers:{'User-Agent':USER_AGENT,'Accept':binary?'*/*':'text/html,application/xhtml+xml,application/xml,text/plain;q=0.8','Accept-Encoding':'gzip, deflate, br',...(authorization&&url.origin===authOrigin?{Authorization:authorization}:{})}
      },res=>{
        const headers=res.headers;
        if([301,302,303,307,308].includes(res.statusCode)) {res.resume();return resolve({status:res.statusCode,headers,body:''});}
        if(headers['content-encoding']&&!['identity','gzip','deflate','br'].includes(headers['content-encoding'])) {res.resume();return reject(Error('媒体返回了不支持的压缩响应，暂时无法读取。'));}
        const type=String(headers['content-type']||'');
        if(!binary&&type&&!/(text\/|html|xml|json)/i.test(type)) {res.resume();return reject(Error('该链接不是可读取的网页。'));}
        let bytes=0;const chunks=[];
        res.on('data',chunk=>{bytes+=chunk.length;if(bytes>maxBytes){res.destroy();reject(Error('页面体积超过检测上限。'));}else chunks.push(chunk);});
        res.on('error',reject);
        res.on('end',()=>{
          let buffer;try{buffer=decodeBody(Buffer.concat(chunks),headers['content-encoding'],maxBytes);}catch{reject(Error('页面体积超过检测上限或压缩格式不受支持。'));return;}if(binary){resolve({status:res.statusCode,headers,buffer,bytes});return;}let body;
          const sample=buffer.subarray(0,2048).toString('ascii');
          const charset=(type.match(/charset\s*=\s*["']?([^;\s"']+)/i)||sample.match(/charset\s*=\s*["']?([^;\s"'>]+)/i))?.[1]||'utf-8';
          try {body=new TextDecoder(charset).decode(buffer);}catch{body=buffer.toString('utf8');}
          resolve({status:res.statusCode,headers,body,bytes});
        });
      });
      const timer=setTimeout(()=>req.destroy(Error('媒体响应超时，请稍后重试。')),timeout);
      req.on('error',reject);req.on('close',()=>clearTimeout(timer));
    });
    if([301,302,303,307,308].includes(page.status)) {
      if(!page.headers.location)throw Error('媒体重定向缺少目标地址。');
      const next=validateUrl(new URL(page.headers.location,url).href);
      redirects.push({from:url.href,status:page.status,to:next.href});url=next;continue;
    }
    return {...page,url:url.href,redirects};
  }
  throw Error('媒体链接重定向次数过多。');
}
