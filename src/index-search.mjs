import {searchGoogle} from './search.mjs';

// Normalize only harmless URL differences; retain content-identifying parameters.
export function articleKey(value){
 try{const u=new URL(value);if(!['http:','https:'].includes(u.protocol))return '';
  u.hash='';for(const key of [...u.searchParams.keys()])if(/^utm_/i.test(key)||/^(gclid|fbclid|msclkid)$/i.test(key))u.searchParams.delete(key);
  u.searchParams.sort();return u.hostname.replace(/^www\./,'')+u.pathname.replace(/\/$/,'')+u.search;
 }catch{return '';}
}
export function matchesArticle(value,urls){const key=articleKey(value);return !!key&&urls.some(url=>articleKey(url)===key);}
export function titleQuery(url,title=''){
 const u=new URL(url),slug=u.pathname.split('/').filter(Boolean).pop()||'';
 let decoded=slug;try{decoded=decodeURIComponent(slug);}catch{}
 const words=(title||decoded.replace(/\.(?:html?|php|aspx?)$/i,'').replace(/[-_]/g,' ')).replace(/["\r\n<>]/g,' ').replace(/\s+/g,' ').trim().split(' ').slice(0,8).join(' ').slice(0,120);
 return words?'site:'+u.hostname.replace(/^www\./,'')+' "'+words+'"':null;
}
export async function searchArticleIndex(url,{signal,context=()=>({}),onUpdate=()=>{},search=searchGoogle}={}){
 const u=new URL(url),query='site:'+u.hostname+u.pathname+u.search;
 const attempts=[];
 const run=async q=>{const data=await search(q,{signal,timeoutMs:6000});attempts.push({query:q,state:data.state,checkedAt:data.checkedAt});
  return data;
 };
 let data=await run(query);
 const urls=()=>[url,context().finalUrl].filter(Boolean);
 const found=d=>d.items?.some(item=>matchesArticle(item.url,urls()));
 if(!found(data)&&!signal?.aborted){
  onUpdate({...data,items:(data.items||[]).filter(item=>matchesArticle(item.url,urls())),state:'pending',note:'正在换用文章标题复核。'});
  const info=context(),fallback=titleQuery(info.finalUrl||url,info.title);
  if(fallback&&fallback!==query){const next=await run(fallback);if(found(next)||next.state==='results'||data.state!=='results')data=next;}
 }
 const exact=found(data),incomplete=attempts.some(a=>a.state==='unavailable')||!!signal?.aborted;
 return {...data,items:(data.items||[]).filter(item=>matchesArticle(item.url,urls())).slice(0,5).map(item=>({...item,exactMatch:true})),attempts,
  state:exact?'results':data.state==='unavailable'?'unavailable':'unconfirmed',
  note:exact?'谷歌搜索中找到本文。':incomplete?'部分查询未完成，暂时无法确认收录情况。':'本次查询暂未确认收录，请到谷歌复核；这不代表未收录。',
  manualSearchUrl:'https://www.google.com/search?hl=en&gl=us&pws=0&q='+encodeURIComponent(query)};
}
