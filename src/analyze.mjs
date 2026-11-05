import {load} from 'cheerio';
import {identifyBrands,isSharingLink} from './brand-links.mjs';
import {parse as parseDomain} from 'tldts';
const compact=s=>String(s||'').replace(/\s+/g,' ').trim();
export function webUrl(value,base) {
  if(typeof value!=='string'||!value.trim())return null;
  try {const u=new URL(value,base);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)return null;u.hash='';return u.href;}catch{return null;}
}
export function comparable(value) {const u=new URL(value);u.hash='';return u.href;}
function graphNodes(value,out=[]) {
  if(Array.isArray(value))value.forEach(v=>graphNodes(v,out));
  else if(value&&typeof value==='object') {out.push(value);if(value['@graph'])graphNodes(value['@graph'],out);}
  return out;
}
export function analyzeHtml(page,targetDomain='') {
  const $=load(page.body);let base=webUrl($('base[href]').first().attr('href'),page.url)||page.url;
  const nodes=[];
  $('script[type="application/ld+json"]').each((_,el)=>{try{graphNodes(JSON.parse($(el).text()),nodes);}catch{}});
  const robots=$('meta[name]').toArray().filter(el=>/^(robots|googlebot)$/i.test($(el).attr('name')||'')).map(el=>compact($(el).attr('content')));
  const xRobots=compact(page.headers['x-robots-tag']);
  const indexDirectives=[...robots,xRobots].join(', ');
  const noindex=/(?:^|[\s,:;])(noindex|none)(?:$|[\s,;])/i.test(indexDirectives);
  const pageNofollow=/(?:^|[\s,:;])(nofollow|none)(?:$|[\s,;])/i.test(indexDirectives);
  const canonical=webUrl($('link[rel~="canonical"]').first().attr('href'),base);
  const title=compact($('meta[property="og:title"]').attr('content')||$('title').first().text()||$('h1').first().text()).slice(0,300);
  $('script,style,noscript,template').remove();
  const selector=['[itemprop="articleBody"]','.article-body','.entry-content','.post-content','article','.prose','main','body'].find(sel=>$(sel).length)||'body';
  const region=$(selector).first().clone();region.find('nav,[aria-label*="readcrumb"],[aria-label*="面包屑"]').remove();
  let scope=selector==='body'?'整页':selector==='main'?'主要内容区域':'文章区域';
  const bodySelectors=['[itemprop="articleBody"]','.elementor-widget-theme-post-content','.elementor-widget-post-content','[data-widget_type="theme-post-content.default"]','.td-post-content','.tdb_single_content','.article-body','.article-content','.entry-content','.post-content','.story-body','.story-content','.article__body','.caas-body','.prose','article'];
  let articleRegion=null;
  for(const sel of bodySelectors){
    const candidates=$(sel).toArray().filter(el=>!$(el).parents('nav,aside,footer,[role="navigation"],.related-posts,.related-articles').length);
    if(candidates.length){candidates.sort((a,b)=>compact($(b).text()).length-compact($(a).text()).length);articleRegion=$(candidates[0]).clone();break;}
  }
  articleRegion?.find('nav,header,footer,aside,[role="navigation"],[role="contentinfo"],[hidden],[aria-hidden="true"],.breadcrumb,.breadcrumbs,[aria-label*="readcrumb"],[aria-label*="面包屑"],.related,.related-posts,.related-articles,.related-content,.recommended,.recommendations,.social-share,.share-buttons,.post-share,.td-post-sharing,.td-post-sharing-bottom,.sharing,.social-sharing,[data-share-url],.author-box,.article-tags,.post-tags,.comments,#comments,.comment-list').remove();
  if(articleRegion)scope='文章正文';
  let linkState=!articleRegion?'unidentified':'ok';
  const allAnchors=articleRegion?articleRegion.find('a[href]').toArray():[];
  const links=[];const counts={dofollow:0,nofollow:0,sponsored:0,ugc:0};let parsed=0;
  for(const el of allAnchors.slice(0,3000)) {
    const a=$(el);const url=webUrl(a.attr('href'),base);if(!url)continue;
    const rel=compact(a.attr('rel')).toLowerCase();const tokens=rel.split(/[\s,]+/).filter(Boolean);
    const attrs=['nofollow','sponsored','ugc'].filter(t=>tokens.includes(t));
    parsed++;
    const host=new URL(url).hostname.toLowerCase().replace(/^www\./,'');
    const targetMatch=!isSharingLink(url)&&!!targetDomain&&(host===targetDomain||host.endsWith('.'+targetDomain));
    if(targetMatch){if(!attrs.length)counts.dofollow++;attrs.forEach(t=>counts[t]++);}
    links.push({anchor:compact(a.text()||a.find('img').attr('alt')||'无文字链接').slice(0,180),url,rel:rel||'未设置',attributes:attrs.length?attrs:['dofollow'],targetMatch,reference:!!a.closest('sup,[role="doc-biblioref"],.references,.reference,.citation').length,context:compact(a.closest('p,li,div').text()).slice(0,180)});
  }
  const automatic=!targetDomain;
  const detected=automatic?identifyBrands(links,page.url,title):{domains:[targetDomain],ambiguous:false,candidates:[]};
  if(automatic){
    for(const key of Object.keys(counts))counts[key]=0;
    for(const link of links){link.targetMatch=!isSharingLink(link.url)&&detected.domains.includes(parseDomain(link.url,{allowPrivateDomains:true}).domain);if(link.targetMatch)link.attributes.forEach(attr=>counts[attr]++);}
    if(articleRegion&&detected.ambiguous)linkState='ambiguous';
    targetDomain=detected.domains.length===1?detected.domains[0]:'';
  }
  const breadcrumbs=[];
  const breadcrumb=nodes.find(n=>[].concat(n['@type']||[]).includes('BreadcrumbList'));
  if(Array.isArray(breadcrumb?.itemListElement))for(const item of breadcrumb.itemListElement) {
    const name=compact(item.name||item.item?.name);if(name)breadcrumbs.push(name.slice(0,100));
  }
  if(!breadcrumbs.length)$('[aria-label*="readcrumb"], [aria-label*="面包屑"], .breadcrumb, .breadcrumbs').first().find('a,li').each((_,el)=>{
    if($(el).is('li')&&$(el).find('a').length)return;const name=compact($(el).text());if(name&&breadcrumbs.at(-1)!==name)breadcrumbs.push(name.slice(0,100));
  });
  const declaredSection=compact($('meta[property="article:section"]').attr('content'));
  const articleSection=nodes.find(n=>[].concat(n['@type']||[]).some(t=>/^(NewsArticle|Article|BlogPosting|TechArticle)$/.test(t))&&n.articleSection)?.articleSection;
  const structuredSection=[].concat(articleSection||[]).filter(v=>typeof v==='string').map(v=>compact($('<div>').html(v.slice(0,300)).text())).filter(Boolean).join(' / ');
  const section=declaredSection||structuredSection||(breadcrumbs.length>2?breadcrumbs[breadcrumbs.length-2]:'');
  const sectionSource=declaredSection?'article:section 元数据':structuredSection?'文章结构化数据':section?'页面面包屑':null;
  const ads=[];
  const pattern=/\b(sponsored(?:\s+content)?|advertisement|advertorial|paid\s+(?:partnership|content|post)|partnered\s+with|native\s+advertising)\b|赞助内容|商业推广|付费内容/gi;
  function scan(text,where){let m;pattern.lastIndex=0;while((m=pattern.exec(text))&&ads.length<24)ads.push({term:m[0],where,context:compact(text.slice(Math.max(0,m.index-60),m.index+100))});}
  const visible=region.clone();visible.find('br').replaceWith(' ');visible.find('p,div,li,h1,h2,h3,h4,section,article,a').append(' ');
  scan(compact(visible.text()),scope);
  $('meta[name="description"],meta[property="og:description"]').each((_,el)=>scan($(el).attr('content')||'','页面描述'));
  for(const node of nodes)if([].concat(node['@type']||[]).some(t=>/Article|Posting/.test(t)))scan(JSON.stringify(node).slice(0,200000),'文章结构化数据');
  for(const link of links.filter(x=>x.attributes.includes('sponsored')).slice(0,8))ads.push({term:'rel="sponsored"',where:'链接属性',context:link.anchor+' → '+link.url});
  let views=null;
  for(const node of nodes) {
    if(![].concat(node['@type']||[]).some(t=>/^(NewsArticle|Article|BlogPosting|TechArticle)$/.test(t)))continue;
    for(const stat of [].concat(node.interactionStatistic||[])) {
      const type=typeof stat.interactionType==='string'?stat.interactionType:stat.interactionType?.['@type'];
      if(!/(?:^|\/)(ReadAction|ViewAction)$/.test(type||''))continue;
      const raw=String(stat.userInteractionCount??'');
      if(/^\d[\d,]*$/.test(raw)) {views={value:raw,source:'文章结构化数据 · '+type};break;}
    }
    if(views)break;
  }
  if(!views)region.find('.post-views,.article-views,.entry-views,[data-view-count]').each((_,el)=>{
    if(views)return;const text=compact($(el).text());
    const value=$(el).attr('data-view-count')||text.match(/(?:views?|reads?|阅读|浏览)\s*[:：]?\s*([\d,.]+\s*[kKmM万亿]?)|([\d,.]+\s*[kKmM万亿]?)\s*(?:views?|reads?|次阅读|次浏览|阅读|浏览)/i)?.slice(1).find(Boolean);
    if(value&&/^\d[\d,.]*\s*[kKmM万亿]?$/.test(value.trim()))views={value:value.trim(),source:'页面公开计数器',context:text.slice(0,160)};
  });
  return {title,scope,robots:robots.filter(Boolean),xRobots,noindex,pageNofollow,canonical,canonicalMismatch:!!canonical&&comparable(canonical)!==comparable(page.url),links:{state:linkState,automatic,detectedDomains:detected.domains,total:links.filter(x=>x.targetMatch).length,counts,items:links.filter(x=>x.targetMatch).slice(0,500),truncated:links.filter(x=>x.targetMatch).length>500||allAnchors.length>3000,targetDomain,targetMatches:links.filter(x=>x.targetMatch).length},ads:{items:ads.slice(0,30),limited:ads.length>=24},section:{name:section||null,source:sectionSource,breadcrumbs,pathHint:new URL(page.url).pathname.split('/').filter(Boolean).slice(0,-1).join('/')||null},views,newsArticle: nodes.some(n=>[].concat(n['@type']||[]).includes('NewsArticle'))};
}

export function homepageMatch(page,articleUrl) {
  const $=load(page.body);const found=[];
  $('a[href]').each((index,el)=>{
    const link=webUrl($(el).attr('href'),page.url);
    if(link&&comparable(link)===comparable(articleUrl)&&found.length<5)found.push({anchor:compact($(el).text()||$(el).find('img').attr('alt')).slice(0,150),url:link,position:index+1});
  });
  return found;
}

export function googleHtml(body) {
  const $=load(body);const text=compact($('body').text());
  if(/unusual traffic|detected unusual|enable javascript|启用 JavaScript|not a robot|consent\.google|captcha/i.test(text))throw Error('谷歌暂时限制自动检索。');
  const items=[];const seen=new Set();
  $('a').each((_,el)=>{
    const a=$(el);const heading=a.find('h3').first();if(!heading.length)return;
    let href=a.attr('href');
    try {const u=new URL(href,'https://www.google.com');if(u.pathname==='/url')href=u.searchParams.get('q')||u.searchParams.get('url');}catch{}
    const link=webUrl(href,'https://www.google.com');
    if(!link||/(^|\.)google\.[^/]+$/.test(new URL(link).hostname)||seen.has(link))return;
    seen.add(link);items.push({title:compact(heading.text()),url:link,snippet:compact(a.parent().text()).slice(0,260)});
  });
  if(!items.length&&!/did not match any documents|No results found|找不到和|没有找到|未找到任何/i.test(text))throw Error('暂时无法读取谷歌检索结果。');
  return items.slice(0,5);
}
