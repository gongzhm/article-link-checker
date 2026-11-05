import test from 'node:test';import assert from 'node:assert/strict';
import {analyzeHtml,homepageMatch,webUrl,googleHtml} from './analyze.mjs';
import {publicAddress,validateUrl} from './fetch-public.mjs';
test('reject private, local, credential and non-web URLs',()=>{
 for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','192.168.1.1','::1','::ffff:127.0.0.1','fc00::1','fe80::1','224.0.0.1'])assert.equal(publicAddress(ip),false,ip);
 assert.equal(publicAddress('8.8.8.8'),true);
 for(const url of ['http://127.0.0.1','http://2130706433','http://[::1]','http://localhost','http://host.local','ftp://media.com','https://u:p@media.com','https://media.com:8090'])assert.throws(()=>validateUrl(url),url);
 assert.equal(webUrl(undefined,'https://media.com/post'),null);
 assert.equal(webUrl('javascript:alert(1)','https://media.com'),null);
});
test('parse actual signals without inventing views, canonical or weights',()=>{
 const result=analyzeHtml({url:'https://media.com/news/one',headers:{'x-robots-tag':'noindex, nofollow'},body:`<html><head><title>Fixture article</title><script type="application/ld+json">{"@type":"NewsArticle","interactionStatistic":[{"interactionType":"LikeAction","userInteractionCount":9000}]}</script></head><body><nav><a href="/other">Nav</a></nav><article><h1>Fixture article</h1><p>Sponsored content</p><a href="https://brand.com/page">Brand</a><a href="https://brand.com/paid" rel="NOFOLLOW sponsored">Paid</a><a href="https://evilbrand.com">Other</a><a href="javascript:alert(1)">Bad</a></article></body></html>`},'brand.com');
 assert.equal(result.noindex,true);assert.equal(result.pageNofollow,true);assert.equal(result.canonical,null);assert.equal(result.views,null);assert.equal(result.links.total,2);assert.equal(result.links.targetMatches,2);assert.equal(result.links.counts.nofollow,1);assert.equal(result.links.counts.sponsored,1);assert.equal(result.links.counts.dofollow,1);assert.ok(result.ads.items.length>=2);assert.equal(result.newsArticle,true);
});
test('extract article read counter and breadcrumb; never treat likes as reads',()=>{
 const result=analyzeHtml({url:'https://media.com/news/a',headers:{},body:`<html><head><link rel="canonical" href="/news/a"/><script type="application/ld+json">{"@graph":[{"@type":"NewsArticle","interactionStatistic":{"interactionType":"https://schema.org/ReadAction","userInteractionCount":"12,480"}},{"@type":"BreadcrumbList","itemListElement":[{"name":"Home"},{"name":"Technology"},{"name":"Article"}]}]}</script></head><body><article>Actual article</article></body></html>`});
 assert.equal(result.views.value,'12,480');assert.equal(result.section.name,'Technology');assert.equal(result.canonicalMismatch,false);assert.equal(result.noindex,false);
});
test('homepage link comparison is exact, not substring matching',()=>{
 const page={url:'https://media.com/',body:'<a href="/news/a#top">A</a><a href="/news/a-other">Wrong</a><a href="https://other.com/news/a">Other</a>'};
 assert.equal(homepageMatch(page,'https://media.com/news/a').length,1);
 assert.equal(homepageMatch(page,'https://media.com/news/z').length,0);
});
test('do not call a blocked Google response an empty search',()=>{
 assert.throws(()=>googleHtml('<body>Our systems detected unusual traffic</body>'));
 assert.throws(()=>googleHtml('<body>Unexpected response</body>'));
 assert.equal(googleHtml('<body>Your search did not match any documents.</body>').length,0);
});

// Relevant search entries must never be reported as an exact article match.
test('separate original URL matches from merely related search results',async()=>{
 const {markResults}=await import('./checker.mjs');
 const d=markResults({requestedUrl:'https://media.com/old',finalUrl:'https://media.com/article',siteSearch:{items:[{url:'https://media.com/article'},{url:'https://other.com/article'}]},webSearch:{items:[{url:'https://media.com/old'},{url:'https://media.com/article-other'}]}});
 assert.deepEqual(d.siteSearch.items.map(i=>i.exactMatch),[true,false]);
 assert.deepEqual(d.webSearch.items.map(i=>i.exactMatch),[true,false]);
});

test('only return brand anchors inside article body, excluding surrounding and related links',()=>{
 const link=(label,host='brand.com',rel='')=>`<a href="https://${host}/${label}" rel="${rel}">${label}</a>`;
 const body=`<header>${link('site-header')}</header><article><header>${link('article-header')}</header><div class="article-body"><p>${link('Brand')}${link('Subdomain','shop.brand.com','nofollow')}${link('Other','evilbrand.com')}${link('Suffix','brand.com.other.com')}</p><nav>${link('navigation')}</nav><aside>${link('aside')}</aside><div class="related-articles">${link('related')}</div><footer>${link('footer')}</footer></div></article><footer>${link('site-footer')}</footer>`;
 const page={url:'https://media.com/a',headers:{},body};
 const result=analyzeHtml(page,'brand.com');
 assert.equal(result.links.state,'ok');assert.equal(result.links.total,2);
 assert.deepEqual(result.links.items.map(l=>l.anchor),['Brand','Subdomain']);
 assert.equal(result.links.counts.dofollow,1);assert.equal(result.links.counts.nofollow,1);
 assert.equal(analyzeHtml(page).links.automatic,true);assert.deepEqual(analyzeHtml(page).links.items.map(x=>x.anchor),['Brand','Subdomain']);
 const unknown=analyzeHtml({...page,body:`<main><p>${link('Unknown')}</p></main>`},'brand.com');
 assert.equal(unknown.links.state,'unidentified');assert.deepEqual(unknown.links.items,[]);
});

test('response budget returns before a slow provider completes; work continues for later results',async()=>{
 const {withinBudget}=await import('./response-budget.mjs');
 let resolve,done=false;const work=new Promise(r=>{resolve=()=>{done=true;r('real-result');};});
 const started=performance.now();await withinBudget(work,40);
 assert.ok(performance.now()-started<250);assert.equal(done,false);
 resolve();assert.equal(await work,'real-result');
 assert.equal(await withinBudget(Promise.resolve('cached-result'),40),'cached-result');
 await assert.rejects(withinBudget(Promise.reject(Error('upstream')),40),/upstream/);
});

test('recognize Elementor article content and exclude surrounding brand links',()=>{
 const body='<header><a href="https://brand.com/nav">Nav</a></header><main><h1>Actual story</h1><div class="elementor-widget-theme-post-content"><div class="elementor-widget-container"><p>A modern <a href="https://brand.com/product">leather sofa</a> holds its shape.</p><p>A <a href="https://brand.com/product">smart living room sofa</a> fits the room.</p></div></div><aside><a href="https://brand.com/related">Related</a></aside></main>';
 const r=analyzeHtml({url:'https://media.com/story',headers:{},body},'brand.com');
 assert.equal(r.links.state,'ok');assert.equal(r.scope,'文章正文');assert.equal(r.links.total,2);
 assert.deepEqual(r.links.items.map(i=>i.anchor),['leather sofa','smart living room sofa']);
});

test('deduplicate Google requests and retry engine failures with alternate parser; failures are not empty results',async()=>{
 const oldFetch=global.fetch,auth=process.env.DATAFORSEO_AUTH;process.env.DATAFORSEO_AUTH='test-only';
 let calls=0;const urls=[];
 global.fetch=async url=>{calls++;urls.push(url);await new Promise(r=>setTimeout(r,15));return {ok:true,json:async()=>({status_code:20000,tasks:[calls===1?{status_code:40101}:{status_code:20000,result:[{items:[{type:'organic',url:'https://brand.com/a',title:'Actual result'}]}]}]})};};
 try{
  const {searchGoogle}=await import('./search.mjs');
  const [a,b]=await Promise.all([searchGoogle('regression-unique-title'),searchGoogle('regression-unique-title')]);
  assert.equal(calls,2);assert.equal(a.items[0].title,'Actual result');assert.equal(b.state,'results');assert.ok(urls[1].endsWith('/advanced'));
  await searchGoogle('regression-unique-title');assert.equal(calls,2);
  global.fetch=async()=>({ok:true,json:async()=>({status_code:20000,tasks:[{status_code:40101}]})});
  assert.equal((await searchGoogle('regression-unavailable-title')).state,'unavailable');
 }finally{global.fetch=oldFetch;if(auth===undefined)delete process.env.DATAFORSEO_AUTH;else process.env.DATAFORSEO_AUTH=auth;}
});

test('decode compressed HTML with an enforced uncompressed size limit',async()=>{
 const {decodeBody}=await import('./fetch-public.mjs');const z=await import('node:zlib');
 const html=Buffer.from('<html><article><p>Brand article</p></article></html>');
 assert.equal(decodeBody(z.gzipSync(html),'gzip').toString(),html.toString());
 assert.equal(decodeBody(z.brotliCompressSync(html),'br').toString(),html.toString());
 assert.equal(decodeBody(z.deflateSync(html),'deflate').toString(),html.toString());
 assert.throws(()=>decodeBody(z.gzipSync(Buffer.alloc(10000)),'gzip',100));
 assert.throws(()=>decodeBody(html,'unsupported'));assert.throws(()=>decodeBody(html,'identity',10));
});

test('read declared article category from JSON-LD, decode entities, and do not use word or comment counts as views',()=>{
 const body='<script type="application/ld+json">{"@graph":[{"@type":"Article","articleSection":["Furniture Placement &amp; Sizing"],"wordCount":962,"commentCount":0}]}</script><main><h1>Story</h1><div class="elementor-widget-theme-post-content"><p>Article body</p></div></main>';
 const r=analyzeHtml({url:'https://media.com/a',headers:{},body},'brand.com');assert.equal(r.section.name,'Furniture Placement & Sizing');assert.equal(r.section.source,'文章结构化数据');assert.equal(r.views,null);
});

test('automatically infer brands, exclude publisher, references and social sites, and avoid guessing ambiguous external links',async()=>{
 const {identifyBrands}=await import('./brand-links.mjs');
 const links=[{url:'https://shop.brand.co.uk/products/a',anchor:'Product'},{url:'https://news.publisher.co.uk/a',anchor:'Related'},{url:'https://wikipedia.org/a',anchor:'Source'},{url:'https://x.com/brand',anchor:'Share'},{url:'https://other.co.uk/a',anchor:'Reference',reference:true}];
 assert.deepEqual(identifyBrands(links,'https://www.publisher.co.uk/story').domains,['brand.co.uk']);
 const ambiguous=identifyBrands([{url:'https://alpha.com/a',anchor:'Read more'},{url:'https://beta.com/a',anchor:'Read more'}],'https://publisher.com/story');
 assert.equal(ambiguous.ambiguous,true);assert.deepEqual(ambiguous.domains,[]);
});

test('Google News parses only news items in order, removes duplicates, limits both search kinds to five',async()=>{
 const {searchItems}=await import('./search.mjs');
 const news=Array.from({length:8},(_,i)=>({type:'news_search',url:`https://news.com/${i}`,title:`News ${i}`}));
 const parsed=searchItems({items:[{type:'organic',url:'https://ads.com',title:'Not news'},...news]},'news');
 assert.equal(parsed.length,5);assert.deepEqual(parsed.map(x=>x.title),['News 0','News 1','News 2','News 3','News 4']);
 const top=searchItems({items:[{type:'top_stories',items:[{type:'top_stories_element',url:'https://news.com/1',title:'Story'}]},news[1]]},'news');assert.equal(top.length,1);
 assert.equal(searchItems({items:news},'organic').length,0);
 assert.equal(searchItems({items:news.map(x=>({...x,type:'organic'}))},'organic').length,5);
});

test('news requests use dedicated endpoint and never reuse ordinary Google cache',async()=>{
 const original=global.fetch,auth=process.env.DATAFORSEO_AUTH;process.env.DATAFORSEO_AUTH='test-only';const called=[];
 global.fetch=async url=>{called.push(url);const news=url.includes('/news/');return {ok:true,json:async()=>({status_code:20000,tasks:[{status_code:20000,result:[{items:[{type:news?'news_search':'organic',url:'https://brand.com/article',title:news?'News':'Web'}]}]}]})};};
 try{const {searchGoogle}=await import('./search.mjs');const web=await searchGoogle('news-separation-test'),news=await searchGoogle('news-separation-test',{kind:'news'});assert.equal(web.items[0].title,'Web');assert.equal(news.items[0].title,'News');assert.equal(news.kind,'news');assert.ok(called[1].endsWith('/google/news/live/advanced'));assert.equal(new URL(news.searchUrl).searchParams.get('tbm'),'nws');}finally{global.fetch=original;if(auth===undefined)delete process.env.DATAFORSEO_AUTH;else process.env.DATAFORSEO_AUTH=auth;}
});

test('retain observed positive Google evidence when a later provider call returns empty',async()=>{
 const originalFetch=global.fetch,originalNow=Date.now,auth=process.env.DATAFORSEO_AUTH;process.env.DATAFORSEO_AUTH='test-only';
 try{const {saveGoogleVerification,searchGoogle}=await import('./search.mjs');
  const q='site:brand.com/verified-regression';saveGoogleVerification(q,[{title:'Observed on Google',url:'https://brand.com/verified-regression'}]);
  const now=originalNow();Date.now=()=>now+16*60000;
  global.fetch=async()=>({ok:true,json:async()=>({status_code:20000,tasks:[{status_code:20000,result:[{items:[]}]}]})});
  const result=await searchGoogle(q);assert.equal(result.stale,true);assert.equal(result.manualVerified,true);assert.equal(result.items[0].title,'Observed on Google');
 }finally{global.fetch=originalFetch;Date.now=originalNow;if(auth===undefined)delete process.env.DATAFORSEO_AUTH;else process.env.DATAFORSEO_AUTH=auth;}
});
