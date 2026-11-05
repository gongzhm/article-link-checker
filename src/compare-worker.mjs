import {parentPort,workerData} from 'node:worker_threads';
import robotsParser from 'robots-parser';
import {fetchPublic,validateUrl} from './fetch-public.mjs';
import {extractContent} from './content.mjs';
import {readOriginal} from './document.mjs';
import {hydrateImages} from './image-match.mjs';
import {compareDocuments} from './compare-core.mjs';
import {resolveWixArticle} from './wix-article.mjs';
const signal=AbortSignal.timeout(28000);
async function publishedPage(value){
 const url=validateUrl(value).href;try{const robotsUrl=new URL('/robots.txt',url).href,r=await fetchPublic(robotsUrl,{timeout:1500,maxBytes:250000,signal});if(r.status===200&&robotsParser(robotsUrl,r.body).isAllowed(url,'ArticleLinkChecker')===false)throw Error('该网站禁止读取，暂时不能比对。');}catch(e){if(e.message.startsWith('该网站'))throw e;}
 const page=await resolveWixArticle(await fetchPublic(url,{signal,timeout:10000}),{signal});if(page.status!==200||/just a moment|checking your browser|verify you are human/i.test(page.body.slice(0,20000)))throw Error('发布文章暂时无法读取，请稍后再试。');return {url:page.url,...extractContent(page.body,page.url)};
}
try{
 const [original,published]=await Promise.all([readOriginal(workerData,signal),publishedPage(workerData.url)]);
 const [oldImages,newImages]=original.images.length?await Promise.all([hydrateImages(original.images,signal),hydrateImages(published.images,signal)]):[[],published.images];original.images=oldImages;published.images=newImages;
 const report=compareDocuments(original,published);report.sourceName=original.sourceName;report.articleUrl=published.url;parentPort.postMessage({report});
}catch(error){parentPort.postMessage({error:/^谷歌|^原稿|^Word|^PDF|^请|^支持|^此 |^发布|^该网站|^暂时|^无法|^稿件/.test(error.message)?error.message:'暂时无法完成比对，请使用 Word 原稿重试。'});}
