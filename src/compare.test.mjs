import test from 'node:test';import assert from 'node:assert/strict';
import {analyzeHtml} from './analyze.mjs';import {isSharingLink} from './brand-links.mjs';
import {extractContent} from './content.mjs';import {compareDocuments,minorChange} from './compare-core.mjs';import {parseDocument,originalUrl} from './document.mjs';
import {buildHtmlReport} from '../public/report.js';
const doc=overrides=>({title:'Firmoo Baddie Glasses',text:'Customers can enjoy clear vision every day. The new collection costs $59 and includes free returns.',links:[{anchor:'Trendy Prescription Glasses',url:'https://www.firmoo.com/z/baddie-collection'}],images:[],...overrides});
test('WhatsApp, share endpoints and sidebar links never become a brand website',()=>{
 for(const url of ['https://web.whatsapp.com/send?text=hello','https://wa.me/123','https://example.org/share?url=a','https://t.me/share/url?url=a'])assert.equal(isSharingLink(url),true);
 const body='<article><h1>Firmoo Glasses</h1><p>Try <a href="https://firmoo.com/z/baddie-collection">Trendy Prescription Glasses</a></p><a href="https://web.whatsapp.com/send?text=hello">Share</a></article>';
 const result=analyzeHtml({url:'https://media.com/a',body,headers:{}});assert.equal(result.links.total,1);assert.equal(result.links.items[0].url,'https://firmoo.com/z/baddie-collection');
 assert.equal(extractContent(body,'https://media.com/a').links.length,1);
});
test('ignore layout, punctuation and minor wording, but retain important numeric and negative changes',()=>{
 const original=doc(),published=doc({text:'Customers can enjoy clear vision\nevery day. The new collection costs $59 and includes free returns.'});
 assert.equal(compareDocuments(original,published).counts.differences,0);
 assert.equal(minorChange('Customers can enjoy clear vision every day.','Customers may enjoy clear vision every day.'),true);
 assert.equal(minorChange('The new collection costs $59 and includes free returns.','The new collection costs $69 and includes free returns.'),false);
 assert.equal(minorChange('Customers can return these glasses within thirty days.','Customers cannot return these glasses within thirty days.'),false);
 const changed=compareDocuments(original,doc({text:'Customers can enjoy clear vision every day. The new collection costs $69 and includes free returns.'}));assert.ok(changed.differences.some(d=>d.type==='正文'));
});
test('list title, anchor, target URL, deleted link and image changes separately',()=>{
 const original=doc({images:[{url:'embedded:1',hash:'1'.repeat(64)}]}),published=doc({title:'A completely different story about sunglasses',links:[{anchor:'Different anchor',url:'https://www.firmoo.com/z/baddie-collection'}],images:[{url:'https://cdn.com/image.jpg',hash:'0'.repeat(64)}]});
 const r=compareDocuments(original,published);assert.ok(r.differences.some(d=>d.type==='标题'));assert.ok(r.differences.some(d=>d.type==='锚文本'));assert.ok(r.differences.some(d=>d.type==='图片'));
 assert.ok(compareDocuments(doc(),doc({links:[{anchor:'Trendy Prescription Glasses',url:'https://other.com'}]})).differences.some(d=>d.detail.includes('网址已改变')));
 assert.ok(compareDocuments(doc(),doc({links:[]})).differences.some(d=>d.detail.includes('链接未')));
});
test('unreadable images are pending, never falsely declared identical or deleted',()=>{
 const r=compareDocuments(doc({images:[{url:'embedded:1',hash:'1'.repeat(64)}]}),doc({images:[{url:'https://cdn.com/a.jpg',unreadable:true}]}));assert.equal(r.state,'partial');assert.ok(r.pending.length);assert.ok(!r.same.includes('图片'));assert.ok(!r.differences.some(d=>d.detail.includes('被删除')));
});
test('Word document retains title, anchor target and embedded image',async()=>{
 const {default:JSZip}=await import('jszip'),{default:sharp}=await import('sharp');const zip=new JSZip();
 zip.file('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
 zip.file('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
 zip.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body><w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Firmoo Baddie Glasses</w:t></w:r></w:p><w:p><w:r><w:t>Customers can enjoy clear vision every day.</w:t></w:r></w:p><w:p><w:hyperlink r:id="rIdLink"><w:r><w:t>Trendy Prescription Glasses</w:t></w:r></w:hyperlink></w:p><w:p><w:r><w:drawing><wp:inline><wp:extent cx="100000" cy="100000"/><wp:docPr id="1" name="image"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="rIdImage"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p></w:body></w:document>');
 zip.file('word/styles.xml','<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style></w:styles>');
 zip.file('word/_rels/document.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://www.firmoo.com/z/baddie-collection" TargetMode="External"/><Relationship Id="rIdImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image.png"/></Relationships>');
 zip.file('word/media/image.png',await sharp({create:{width:60,height:40,channels:3,background:'#778899'}}).png().toBuffer());
 const data=await zip.generateAsync({type:'nodebuffer'}),parsed=await parseDocument(data,'original.docx');assert.equal(parsed.title,'Firmoo Baddie Glasses');assert.equal(parsed.links[0].anchor,'Trendy Prescription Glasses');assert.equal(parsed.images.length,1);assert.ok(parsed.images[0].hash);
});
test('online Google documents use public export, private addresses rejected, corrupt uploads fail',async()=>{
 assert.equal(originalUrl('https://docs.google.com/document/d/abc123/edit'),'https://docs.google.com/document/d/abc123/export?format=docx');assert.throws(()=>originalUrl('http://127.0.0.1/secret'));
 await assert.rejects(parseDocument(Buffer.from('PKinvalid'),'file.docx'));await assert.rejects(parseDocument(Buffer.from([0,255,0]),'file.doc'));
 const parsed=await parseDocument(Buffer.from('My Article\n\nCustomers can enjoy clear vision every day.\n\n[Product](https://brand.com/product)'),'file.md');assert.equal(parsed.title,'My Article');assert.equal(parsed.links[0].url,'https://brand.com/product');
});
test('HTML report includes the complete brief and escapes untrusted content',()=>{
 const report=compareDocuments(doc(),doc({title:'<script>alert(1)</script>'}));const html=buildHtmlReport({checkedAt:'now',requestedUrl:'https://media.com/a',analysis:{title:'<img onerror=alert(1)>',links:{items:[]}},siteSearch:{state:'no_results',items:[]},newsSearch:{state:'no_results',items:[]}},report);
 assert.ok(html.startsWith('<!doctype html>'));assert.ok(html.includes('原稿对比简报'));assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<img onerror='));assert.ok(html.includes('&lt;script&gt;'));
});

test('PDF text and hyperlink are readable; unverified PDF images stay pending',async()=>{
 const stream='BT /F1 18 Tf 40 750 Td (My Product Title) Tj 0 -40 Td /F1 12 Tf (Customers can enjoy clear vision every day.) Tj ET';
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R /Annots [6 0 R] >>',`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>','<< /Type /Annot /Subtype /Link /Rect [40 700 290 725] /A << /S /URI /URI (https://brand.com/product) >> >>'];
 let source='%PDF-1.4\n',offsets=[0];for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(source));source+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}const at=Buffer.byteLength(source);source+=`xref\n0 7\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n ').join('\n')}\ntrailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${at}\n%%EOF`;
 const parsed=await parseDocument(Buffer.from(source),'original.pdf');assert.equal(parsed.title,'My Product Title');assert.ok(parsed.text.includes('clear vision'));assert.equal(parsed.links[0].url,'https://brand.com/product');assert.equal(parsed.imagesUnknown,true);
});

test('image resizing and compression can match, but different colors cannot silently match',async()=>{
 const {default:sharp}=await import('sharp'),{imageSignature,sameImage}=await import('./image-match.mjs');
 const red=await sharp({create:{width:120,height:80,channels:3,background:'#cc2222'}}).png().toBuffer();
 const blue=await sharp({create:{width:120,height:80,channels:3,background:'#2222cc'}}).png().toBuffer();
 const smaller=await sharp(red).resize(60,40).jpeg({quality:85}).toBuffer();
 assert.equal(sameImage(await imageSignature(red),await imageSignature(smaller)),true);assert.equal(sameImage(await imageSignature(red),await imageSignature(blue)),false);
});

// Public Google document failures must be actionable, and never parse a sign-in page as a draft.
import {readOriginal} from './document.mjs';
test('Google documents preserve publication IDs, user-index links and resource keys',()=>{
 assert.equal(originalUrl('https://docs.google.com/document/u/0/d/abc123/edit?resourcekey=key-value&usp=sharing'),'https://docs.google.com/document/d/abc123/export?format=docx&resourcekey=key-value');
 assert.equal(originalUrl('https://docs.google.com/document/d/e/2PACX-example/pub'),'https://docs.google.com/document/d/e/2PACX-example/pub');
});
test('Google document export falls back to public HTML and retains outgoing link targets',async()=>{
 const calls=[];const source='https://docs.google.com/document/d/abc123/edit';
 const result=await readOriginal({originalUrl:source},undefined,{fetchDocument:async url=>{calls.push(url);return calls.length===1?{status:500,url,buffer:Buffer.alloc(0)}:{status:200,url,buffer:Buffer.from('<html><h1>Customer Article</h1><p>This is the original customer article with a <a href="https://www.google.com/url?q=https%3A%2F%2Fbrand.com%2Fproduct">Brand product</a> to compare.</p></html>')};}});
 assert.ok(calls[1].includes('/mobilebasic'));assert.equal(result.title,'Customer Article');assert.equal(result.links[0].url,'https://brand.com/product');
});
test('Google network failure, permissions and missing documents have distinct messages',async()=>{
 for(const [status,expected] of [[0,/连接失败/],[403,/阅读权限/],[404,/未找到/]])await assert.rejects(readOriginal({originalUrl:'https://docs.google.com/document/d/abc123/edit'},undefined,{fetchDocument:async url=>{if(!status)throw Error('DNS/connect');return {status,url,buffer:Buffer.alloc(0)};}}),expected);
 await assert.rejects(readOriginal({originalUrl:'https://docs.google.com/document/d/abc123/edit'},undefined,{fetchDocument:async url=>({status:200,url,buffer:Buffer.from('<title>Sign in - Google Accounts</title><p>Please sign in before viewing this document.</p>')})}),/阅读权限/);
});

test('keep draft subheadings and ignore missing spaces between sentences',()=>{
 const draft=extractContent('<h1>Customer title</h1><h1>Important subheading</h1><p>This paragraph contains more than twenty characters.</p>','https://original.com/',{original:true});
 assert.ok(draft.text.includes('Important subheading'));assert.ok(!draft.text.includes('Customer title'));
 const original=doc({text:'These products meet the standards.This ensures clean water for every household. The total price is $59 for this complete package.'});
 const published=doc({text:'These products meet the standards. This ensures clean water for every household. The total price is $69 for this complete package.'});
 const changes=compareDocuments(original,published).differences.filter(d=>d.type==='正文');assert.equal(changes.length,1);assert.ok(changes[0].after.includes('$69'));
});

test('include an article lead image outside the body while excluding unrelated images',()=>{
 const html='<nav><img src="https://cdn.com/nav.jpg"></nav><div class="article-text v_text"><h1>Customer title</h1><figure class="imageBox"><picture><img src="https://cdn.com/lead.jpg"></picture></figure><div class="article-body"><p>This paragraph contains more than twenty characters.</p><img src="https://cdn.com/body.jpg"></div></div><aside><img src="https://cdn.com/ad.jpg"></aside>';
 const result=extractContent(html,'https://publisher.com/article');assert.deepEqual(result.images.map(i=>i.url).sort(),['https://cdn.com/body.jpg','https://cdn.com/lead.jpg']);
});

test('retry transient image failure and reuse only short-lived public image fingerprints',async()=>{
 const {default:sharp}=await import('sharp'),{hydrateImages}=await import('./image-match.mjs');const png=await sharp({create:{width:60,height:40,channels:3,background:'#778899'}}).png().toBuffer();
 const signatureCache=new Map();let calls=0;const fetchImage=async()=>{if(++calls===1)throw Error('transient timeout');return {status:200,headers:{'content-type':'image/png'},buffer:png};};
 const options={fetchImage,signatureCache,persist:false},image={url:'https://cdn.com/public-image.jpg'};
 const first=await hydrateImages([image],undefined,options);assert.ok(first[0].hash);assert.equal(calls,2);
 const cached=await hydrateImages([image],undefined,options);assert.equal(cached[0].imageCached,true);assert.equal(calls,2);
 await hydrateImages([{url:'embedded:1',hash:first[0].hash}],undefined,options);assert.equal(signatureCache.size,1);
 signatureCache.set(image.url,{at:Date.now()-601000,hash:first[0].hash});await hydrateImages([image],undefined,options);assert.equal(calls,3);
});

test('single Elementor article excludes repeated recommendation covers inside and outside its template',()=>{
 const card=n=>`<div class="e-loop-item" data-elementor-type="loop-item"><div class="elementor-widget-theme-post-featured-image"><a href="/other-${n}"><img src="https://cdn.com/other-${n}.jpg"></a></div></div>`;
 const html=`<div class="elementor-location-single" data-elementor-type="single-post"><h1>Watering decisions</h1><div class="elementor-widget-theme-post-featured-image"><img src="https://cdn.com/cover.jpg"></div><div class="elementor-widget-theme-post-content"><p>The main article has enough text for reliable extraction.</p><img src="https://cdn.com/body.jpg">${card(0)}</div>${Array.from({length:9},(_,i)=>card(i+1)).join('')}</div><article><div class="featured-image"><img src="https://cdn.com/unrelated.jpg"></div></article>`;
 const result=extractContent(html,'https://publisher.com/watering');assert.deepEqual(result.images.map(i=>i.url).sort(),['https://cdn.com/body.jpg','https://cdn.com/cover.jpg']);assert.equal(result.imageCount,2);
});
