import sharp from 'sharp';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {fetchPublic} from './fetch-public.mjs';
sharp.cache(false);
let imageQueue=Promise.resolve();
export function imageSignature(buffer){const work=imageQueue.then(()=>signature(buffer));imageQueue=work.catch(()=>{});return work;}
async function signature(buffer){
 const rgb=await sharp(buffer,{limitInputPixels:16000000,failOn:'warning'}).rotate().flatten({background:'#ffffff'}).resize(16,16,{fit:'fill'}).toColourspace('srgb').removeAlpha().raw().toBuffer();
 const pixels=await sharp(rgb,{raw:{width:16,height:16,channels:3}}).resize(9,8,{fit:'fill'}).greyscale().raw().toBuffer();
 return {bits:Array.from({length:64},(_,i)=>pixels[Math.floor(i/8)*9+i%8]>pixels[Math.floor(i/8)*9+i%8+1]?'1':'0').join(''),pixels:Array.from(rgb)};
}
export function sameImage(a,b){
 const x=typeof a==='string'?a:a?.bits,y=typeof b==='string'?b:b?.bits;
 if(!x||!y||x.length!==64||y.length!==64||[...x].reduce((n,v,i)=>n+(v!==y[i]),0)>8)return false;
 if(a?.pixels&&b?.pixels){if(a.pixels.length!==b.pixels.length)return false;const rmse=Math.sqrt(a.pixels.reduce((n,v,i)=>n+(v-b.pixels[i])**2,0)/a.pixels.length);return rmse<=16;}
 return true;
}
export function imageKey(url){try{const u=new URL(url);u.hash='';for(const k of [...u.searchParams.keys()])if(/^(?:w|h|width|height|resize|quality|q|format|fit|crop|auto|utm_.+)$/i.test(k))u.searchParams.delete(k);u.pathname=u.pathname.replace(/-\d{2,4}x\d{2,4}(?=\.[a-z]+$)/i,'');return u.href;}catch{return url;}}
import path from 'node:path';
import {DATA_DIR} from './config.mjs';
const imageCacheFile=process.env.IMAGE_CACHE||path.join(DATA_DIR,'image-signatures.json');
function readCache(){try{if(fs.statSync(imageCacheFile).size>1000000)return new Map();return new Map(JSON.parse(fs.readFileSync(imageCacheFile,'utf8')).filter(([,v])=>Date.now()-v.at<600000));}catch{return new Map();}}
function saveCache(cache){let temp;try{while(cache.size>120)cache.delete(cache.keys().next().value);temp=imageCacheFile+'.'+randomUUID()+'.tmp';fs.writeFileSync(temp,JSON.stringify([...cache]),{mode:0o600});fs.renameSync(temp,imageCacheFile);}catch{if(temp)try{fs.unlinkSync(temp);}catch{}}}
export async function hydrateImages(images,signal,{fetchImage=fetchPublic,signatureCache,persist=true}={}){
 const cache=signatureCache||readCache();let changed=false;
 const result=[];
 for(let i=0;i<images.length;i+=3){result.push(...await Promise.all(images.slice(i,i+3).map(async item=>{
  if(item.hash)return item;
  const saved=cache.get(item.url);if(saved&&Date.now()-saved.at<600000)return {...item,hash:saved.hash,imageCached:true};
  for(let attempt=0;attempt<2&&!signal?.aborted;attempt++){
   try{const r=await fetchImage(item.url,{binary:true,maxBytes:4000000,timeout:4000,signal});if(r.status!==200||!String(r.headers['content-type']).startsWith('image/'))throw Error();const hash=await imageSignature(r.buffer);cache.set(item.url,{at:Date.now(),hash});changed=true;return {...item,hash};}catch{}
  }
  return {...item,unreadable:true};
 })));}
 // Only public media image fingerprints are cached. Uploaded draft bytes and
 // embedded draft image fingerprints never enter this shared cache.
 if(changed&&persist&&!signatureCache)saveCache(cache);
 return result;
}
