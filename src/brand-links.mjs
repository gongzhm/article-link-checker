import {parse} from 'tldts';
const excluded=new Set(['whatsapp.com','wa.me','telegram.org','t.me','line.me','weibo.com','wechat.com','vk.com','tumblr.com','buffer.com','addtoany.com','sharethis.com','wikipedia.org','wikimedia.org','facebook.com','instagram.com','twitter.com','x.com','linkedin.com','youtube.com','youtu.be','pinterest.com','tiktok.com','reddit.com','google.com','bing.com','doi.org','pubmed.ncbi.nlm.nih.gov','ncbi.nlm.nih.gov','researchgate.net','sciencedirect.com','springer.com','linktr.ee','bit.ly','t.co']);
const sharingDomains=new Set(['whatsapp.com','wa.me','telegram.org','t.me','line.me','facebook.com','instagram.com','twitter.com','x.com','linkedin.com','youtube.com','youtu.be','pinterest.com','tiktok.com','reddit.com','wechat.com','weibo.com','vk.com','tumblr.com','buffer.com','addtoany.com','sharethis.com']);
const domain=value=>parse(value,{allowPrivateDomains:true}).domain;
export function isSharingLink(value){
 try{const u=new URL(value),d=domain(value);return sharingDomains.has(d)||/(?:^|\/)(?:share|sharer|sharing|intent|shareArticle)(?:[/.]|$)/i.test(u.pathname)||(/^(?:web\.)?whatsapp\.com$/.test(u.hostname));}catch{return true;}
}
export function identifyBrands(links,pageUrl,title=''){
 const publisher=domain(pageUrl),groups=new Map();
 for(const link of links){
  const d=domain(link.url);if(!d||d===publisher||excluded.has(d)||isSharingLink(link.url)||link.reference)continue;
  const u=new URL(link.url);if(/\.(?:pdf|jpe?g|png|gif|webp|svg|zip)$/i.test(u.pathname))continue;
  const group=groups.get(d)||{domain:d,links:[],score:0};group.links.push(link);
  const label=parse(d,{allowPrivateDomains:true}).domainWithoutSuffix||'';
  const text=(link.anchor+' '+title).toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
  if(label.length>=4&&text.includes(label.replace(/-/g,'')))group.score=Math.max(group.score,4);
  if(/\/(?:products?|shop|collections?|pricing|purchase|buy)(?:\/|$)/i.test(u.pathname))group.score=Math.max(group.score,3);
  groups.set(d,group);
 }
 const candidates=[...groups.values()];
 const chosen=candidates.length===1?candidates:candidates.filter(g=>g.score>=3);
 return {domains:chosen.map(g=>g.domain),ambiguous:candidates.length>1&&!chosen.length,candidates:candidates.map(g=>g.domain)};
}
