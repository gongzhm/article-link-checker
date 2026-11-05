import test from 'node:test';
import assert from 'node:assert/strict';
import {articleKey,matchesArticle,searchArticleIndex,titleQuery} from './index-search.mjs';
const url='https://www.techtimes.com/articles/313040/20251128/intelligize-your-water-invest-smart-water-purifier-your-familys-long-term-health-this-black.htm';
test('match protocol, www and tracking variants; do not match another article or content query',()=>{
 assert.equal(matchesArticle(url.replace('https://www.','http://')+'?utm_source=google',[url]),true);
 assert.equal(matchesArticle(url+'?id=2',[url]),false);
 assert.equal(matchesArticle(url.replace('313040','313041'),[url]),false);
 assert.equal(articleKey('javascript:alert(1)'), '');
 assert.equal(matchesArticle('broken',[url]),false);
});
test('recheck long URL with title; expose the actual matching query and at most five results',async()=>{
 const calls=[],progress=[];
 const result=await searchArticleIndex(url,{context:()=>({title:'Intelligize Your Water: Invest in a Smart Water Purifier'}),onUpdate:x=>progress.push(x),search:async q=>{calls.push(q);return {kind:'organic',query:q,state:calls.length===1?'no_results':'results',items:calls.length===1?[]:[{url,title:'Actual article'}]};}});
 assert.equal(calls.length,2);assert.ok(calls[1].startsWith('site:techtimes.com "Intelligize'));
 assert.equal(result.state,'results');assert.equal(result.items[0].exactMatch,true);assert.equal(result.query,calls[1]);assert.equal(progress[0].state,'pending');assert.equal(result.attempts.length,2);
});
test('related results and provider failure never assert the article is not indexed',async()=>{
 for(const state of ['no_results','unavailable','results']){
  const result=await searchArticleIndex(url,{search:async q=>({query:q,state,items:state==='results'?[{url:'https://www.techtimes.com/articles/other',title:'Related'}]:[]})});
  assert.equal(result.state,state==='unavailable'?'unavailable':'unconfirmed');assert.ok(!result.items.some(x=>x.exactMatch));
 }
});
test('do not spend another search when the exact requested or redirected article was found',async()=>{
 let calls=0;const result=await searchArticleIndex(url,{search:async()=>{calls++;return {state:'results',items:[{url}]};}});
 assert.equal(calls,1);assert.equal(result.state,'results');
 assert.ok(titleQuery('https://publisher.com/a-smart-product.htm').includes('a smart product'));
 assert.doesNotThrow(()=>titleQuery('https://publisher.com/bad%ZZ-slug'));
});

test('hide all unrelated site results in progress and final responses, including same-domain pages',async()=>{
 const progress=[];const unrelated=Array.from({length:5},(_,i)=>({url:`https://www.techtimes.com/articles/other-${i}`,title:'Other article'}));
 const result=await searchArticleIndex(url,{onUpdate:r=>progress.push(r),search:async()=>({state:'results',items:unrelated})});
 assert.equal(result.state,'unconfirmed');assert.deepEqual(result.items,[]);assert.ok(progress.every(r=>r.items.length===0));
});
test('mixed results keep only requested and verified redirect URLs, not similar titles',async()=>{
 const target='https://publisher.com/updated-article';
 const result=await searchArticleIndex(url,{context:()=>({finalUrl:target}),search:async()=>({state:'results',items:[{url:'https://www.techtimes.com/other',title:'Same title'},{url:target+'?utm_source=google',title:'Redirected article'},{url:'https://evil.com/updated-article'}]})});
 assert.equal(result.state,'results');assert.equal(result.items.length,1);assert.equal(result.items[0].exactMatch,true);
});
