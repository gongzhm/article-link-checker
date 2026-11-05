import {load} from 'cheerio';
import {fetchPublic} from './fetch-public.mjs';
const BLOG='14bcded7-0066-7c35-14d7-466cb3f09103';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const key=u=>{const x=new URL(u);return x.origin+x.pathname.replace(/\/$/,'');};
function linkUrl(value){
 if(typeof value!=='string')return null;
 const raw=/^[\w-]+(?:\.[\w-]+)+(?:\/|$)/.test(value)?'http://'+value:value;
 try{const u=new URL(raw);return /^https?:$/.test(u.protocol)&&!u.username&&!u.password?u.href:null;}catch{return null;}
}
export function wixPostHtml(post,url){
 if(!post?.url?.base||!post.url.path||key(new URL(post.url.path,post.url.base))!==key(url))throw Error('发布文章网址不匹配，暂时不能比对。');
 if(post.preview||post.pricingPlanIds?.length)throw Error('发布文章需要阅读权限，暂时不能比对。');
 if(!post.title||!Array.isArray(post.richContent?.nodes))throw Error('发布文章正文尚未完整读取。');
 let count=0;
 function render(n,depth=0){
  if(++count>12000||depth>40)throw Error('发布文章结构超过读取上限。');
  if(n.type==='TEXT'){
   const data=n.textData||{};let text=esc(data.text);const d=data.decorations?.find(x=>x.type==='LINK');
   const link=d?.linkData?.link,href=linkUrl(link?.url);
   if(href){const rel=['nofollow','sponsored','ugc','noreferrer','noopener'].filter(k=>link.rel?.[k]).join(' ');text=`<a href="${esc(href)}" rel="${esc(rel)}">${text}</a>`;}return text;
  }
  if(n.type==='IMAGE'){
   const data=n.imageData||{},src=data.image?.src;const href=src?.id&&/^[\w.~%-]+$/.test(src.id)?'https://static.wixstatic.com/media/'+src.id:linkUrl(src?.url);
   if(!href)throw Error('发布文章包含暂时无法识别的图片。');
   return `<figure><img src="${esc(href)}" alt="${esc(data.altText)}"></figure>`;
  }
  const children=(n.nodes||[]).map(x=>render(x,depth+1)).join('');
  const tags={PARAGRAPH:'p',HEADING:'h'+Math.max(2,Math.min(6,Number(n.headingData?.level)||2)),BULLETED_LIST:'ul',ORDERED_LIST:'ol',LIST_ITEM:'li',BLOCKQUOTE:'blockquote',DIVIDER:'hr'};
  if(!tags[n.type]&&!children)throw Error('发布文章包含暂时无法读取的内容，请人工核对。');
  const tag=tags[n.type]||'div';return `<${tag}>${children}</${tag}>`;
 }
 const body=post.richContent.nodes.map(n=>render(n)).join('');
 if(load(body).text().trim().length<100)throw Error('发布文章正文尚未完整读取。');
 return `<!doctype html><html><head><title>${esc(post.title)}</title><link rel="canonical" href="${esc(url)}"></head><body><article><h1>${esc(post.title)}</h1><div itemprop="articleBody">${body}</div></article></body></html>`;
}
export async function resolveWixArticle(page,{signal,fetchPage=fetchPublic}={}){
 const $=load(page.body);
 if(page.status!==200||!$('#wix-viewer-model').length||$('article,[itemprop="articleBody"]').text().trim().length>100)return page;
 const u=new URL(page.url),match=u.pathname.match(/^\/post\/([^/]+)\/?$/);if(!match)return page;
 // Anonymous visitor token from this same public site, never an account credential.
 const token=await fetchPage(u.origin+'/_api/v1/access-tokens',{signal,timeout:4000,maxBytes:500000});
 if(token.status!==200)throw Error('发布文章动态内容暂时无法读取，请稍后重试。');
 const instance=JSON.parse(token.body).apps?.[BLOG]?.instance;
 if(typeof instance!=='string'||instance.length>12000)throw Error('发布文章动态内容暂时无法读取，请稍后重试。');
 const target=u.origin+'/_api/communities-blog-node-api/v3/posts/slugs/'+encodeURIComponent(decodeURIComponent(match[1]))+'?fieldsets=CONTENT_TEXT&fieldsets=RICH_CONTENT&fieldsets=URL';
 const response=await fetchPage(target,{signal,timeout:5000,maxBytes:2000000,authorization:instance});
 if(response.status!==200)throw Error('发布文章动态内容暂时无法读取，请稍后重试。');
 const article=load(wixPostHtml(JSON.parse(response.body).post,page.url));
 $('body').html(article('body').html());
 if(!$('title').text().trim())$('head').append(article('title').clone());
 const body=$.html();
 return {...page,body,articleSource:'媒体公开文章数据',bytes:Buffer.byteLength(body)};
}
