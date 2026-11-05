import {load} from 'cheerio';
import {webUrl} from './analyze.mjs';
import {isSharingLink} from './brand-links.mjs';
const compact=s=>String(s||'').replace(/\s+/g,' ').trim();
const selectors=['[itemprop="articleBody"]','.elementor-widget-theme-post-content','.elementor-widget-post-content','[data-widget_type="theme-post-content.default"]','.td-post-content','.tdb_single_content','.article-body','.article-content','.entry-content','.post-content','.story-body','.story-content','.article__body','.caas-body','.wp-block-post-content','.prose','article'];
export function extractContent(body,url,{original=false,imageLookup=new Map()}={}){
 const $=load(body);$('script,style,noscript,template,nav,footer,aside,[role="navigation"],.related,.related-posts,.related-articles,.related-content,.recommended,.recommendations,.social-share,.share-buttons,.share,.sharing,.post-share,.td-post-sharing,.author-box,.article-tags,.post-tags,.comments,#comments,.comment-list,.breadcrumb,.breadcrumbs').remove();
 // Repeated post cards are separate articles, even inside a single-post template.
 $('.e-loop-item,[data-elementor-type="loop-item"],.elementor-posts-container,.elementor-loop-container,.elementor-widget-author-box').remove();
 let region,sourceRegion;
 for(const selector of selectors){const matches=$(selector).toArray();if(matches.length){matches.sort((a,b)=>$(b).text().length-$(a).text().length);sourceRegion=$(matches[0]);region=sourceRegion.clone();break;}}
 if(!region&&original)region=$('body').clone();
 if(!region)throw Error('暂时无法识别发布文章的正文，不能可靠比对。');
 let title=compact($('h1.entry-title,h1.post-title,h1.article-title,article h1,main h1').first().text()||$('h1').first().text()||$('meta[property="og:title"]').attr('content')||$('title').first().text());
 if(original&&!title&&region.find('p').length>1){const first=region.find('p').first();if(first.text().length<300){title=compact(first.text());first.remove();}}
 region.find('header').remove();
 // Only the document title is excluded from body comparison. Later h1 headings
 // in a Word/Google draft are article content, not duplicate page titles.
 const firstHeading=region.find('h1').first();if(compact(firstHeading.text())===title)firstHeading.remove();
 const links=[];region.find('a[href]').each((_,el)=>{const a=$(el),href=webUrl(a.attr('href'),url);if(a.find('img').length&&!compact(a.text()))return;if(href&&!isSharingLink(href)&&!a.closest('sup,.references,.citation,[role="doc-biblioref"]').length)links.push({anchor:compact(a.text()||a.find('img').attr('alt')),url:href});});
 const imageEls=region.find('img').toArray();
 // Include a lead image only inside the selected article's own wrapper.
 // Never scan all featured-image widgets across the page.
 const ownerSelector='article,.article-text,.elementor-location-single,[data-elementor-type="single-post"],.hentry';
 const owner=sourceRegion?.closest(ownerSelector);
 if(owner?.length)owner.find('.post-thumbnail img,.featured-image img,.td-post-featured-image img,.elementor-widget-theme-post-featured-image img,.article-text > figure.imageBox img').each((_,el)=>{
  if($(el).closest(ownerSelector)[0]===owner[0])imageEls.push(el);
 });
 const images=[],seen=new Set();
 for(const el of imageEls){const img=$(el);if((Number(img.attr('width'))>0&&Number(img.attr('width'))<=10)||(Number(img.attr('height'))>0&&Number(img.attr('height'))<=10)||/avatar|logo|emoji|tracking/i.test(img.attr('class')||''))continue;
  const src=img.attr('data-lazy-src')||img.attr('data-src')||img.attr('src');const embedded=imageLookup.get(src);const href=embedded?src:webUrl(src,url);if(!href||seen.has(href))continue;seen.add(href);images.push(embedded||{url:href,alt:compact(img.attr('alt'))});
 }
 region.find('p,li,h1,h2,h3,h4,div,br').append('\n');const text=region.text().split(/\n+/).map(compact).filter(Boolean).join('\n').slice(0,100000);
 if(text.length<20)throw Error(original?'原稿正文过少或链接需要登录，请上传文档或使用公开链接。':'发布文章正文过少，暂时不能比对。');
 return {title:title.slice(0,400),text,links:links.slice(0,300),images:images.slice(0,16),imageCount:images.length,imageLimited:images.length>16};
}
