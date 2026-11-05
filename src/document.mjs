import mammoth from 'mammoth';
import {fileURLToPath} from 'node:url';
import yauzl from 'yauzl';
import {marked} from 'marked';
import {extractContent} from './content.mjs';
import {imageSignature} from './image-match.mjs';
import {fetchPublic,validateUrl} from './fetch-public.mjs';
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function validateZip(buffer){
 await new Promise((resolve,reject)=>yauzl.fromBuffer(buffer,{lazyEntries:true,validateEntrySizes:true},(error,zip)=>{
  if(error)return reject(Error('Word 文档无法读取，请另存为 .docx 后重试。'));
  let count=0,total=0,stopped=false;const fail=e=>{if(stopped)return;stopped=true;zip.close();reject(e);};
  zip.on('error',fail);zip.on('end',()=>{if(!stopped)resolve();});zip.on('entry',entry=>{
   if(++count>500||entry.uncompressedSize>12000000)return fail(Error('Word 文档内容过大，请拆分稿件。'));
   if(/\/$/.test(entry.fileName)){zip.readEntry();return;}
   zip.openReadStream(entry,(e,stream)=>{if(e)return fail(e);stream.on('data',chunk=>{total+=chunk.length;if(total>25000000){stream.destroy();fail(Error('Word 文档解压后过大，请压缩图片后重试。'));}});stream.on('error',fail);stream.on('end',()=>{if(!stopped)zip.readEntry();});});
  });zip.readEntry();
 }));
}
export async function parseDocument(buffer,name,baseUrl='https://original.invalid/'){
 if(!buffer.length||buffer.length>6000000)throw Error('请上传不超过 6 MB 的稿件。');
 if(buffer.subarray(0,4).toString()==='%PDF')return parsePdf(buffer);
 if(buffer[0]===0x50&&buffer[1]===0x4b){
  await validateZip(buffer);const images=new Map();let imageCount=0;
  const converted=await mammoth.convertToHtml({buffer},{externalFileAccess:false,styleMap:["p[style-name='Title'] => h1:fresh"],convertImage:mammoth.images.imgElement(async image=>{
   const id='embedded:'+ (++imageCount);if(imageCount>16)return {src:id};
   try{const content=await image.read();const hash=await imageSignature(content);images.set(id,{url:id,hash,alt:`原稿图片 ${imageCount}`});}catch{images.set(id,{url:id,unreadable:true,alt:`原稿图片 ${imageCount}`});}return {src:id};
  })});
  const result=extractContent(converted.value,baseUrl,{original:true,imageLookup:images});result.imageCount=imageCount;result.imageLimited=imageCount>16;return result;
 }
 let text;try{text=new TextDecoder(buffer[0]===0xff&&buffer[1]===0xfe?'utf-16le':'utf-8',{fatal:true}).decode(buffer);}catch{throw Error('无法读取此文档，请上传 Word（.docx）、PDF、TXT 或 HTML。');}
 if(/<(?:html|body|h1|article|p)\b/i.test(text))return extractContent(text,baseUrl,{original:true});
 if(!/\.(?:txt|md|markdown)$/i.test(name||''))throw Error('支持 Word（.docx）、PDF、TXT、Markdown 和 HTML；旧版 .doc 请另存为 .docx。');
 const lines=text.trim().split(/\r?\n/);if(lines[0]&&!/^#/.test(lines[0])&&lines[0].length<300)lines[0]='# '+lines[0];
 const result=extractContent(marked.parse(lines.join('\n')),baseUrl,{original:true});result.imagesUnknown=/\.txt$/i.test(name||'');return result;
}
async function parsePdf(buffer){
 const {getDocument,OPS}=await import('pdfjs-dist/legacy/build/pdf.mjs');
 const task=getDocument({data:new Uint8Array(buffer),isEvalSupported:false,enableXfa:false,useSystemFonts:false,disableFontFace:true,maxImageSize:1000000,useWorkerFetch:false,standardFontDataUrl:new URL('standard_fonts/',import.meta.resolve('pdfjs-dist/package.json')).href});
 const pdf=await task.promise;
 try{
  if(pdf.numPages>20)throw Error('PDF 超过 20 页，请仅上传稿件部分。');
  const paragraphs=[],links=[],images=[];let title='',imageCount=0,unknown=false;
  for(let number=1;number<=pdf.numPages;number++){
   const page=await pdf.getPage(number),content=await page.getTextContent();let line='';const lines=[];
   for(const item of content.items){if(!item.str){if(item.hasEOL&&line){lines.push(line);line='';}continue;}line+=(line?' ':'')+item.str;if(item.hasEOL){lines.push(line);line='';}}if(line)lines.push(line);
   if(!title&&lines.length)title=lines.shift();paragraphs.push(...lines);
   for(const annotation of await page.getAnnotations()){if(!annotation.url||!/^https?:\/\//i.test(annotation.url))continue;let anchor=content.items.filter(item=>item.transform&&item.transform[4]+item.width>=annotation.rect[0]&&item.transform[4]<=annotation.rect[2]&&item.transform[5]>=annotation.rect[1]-3&&item.transform[5]<=annotation.rect[3]+3).map(item=>item.str).join(' ').trim();links.push({anchor:anchor||'PDF 中的链接',anchorUnknown:!anchor,url:annotation.url});}
   const operators=await page.getOperatorList();
   for(let i=0;i<operators.fnArray.length;i++){
    if(![OPS.paintImageXObject,OPS.paintInlineImageXObject].includes(operators.fnArray[i]))continue;
    imageCount++;if(images.length>=16){unknown=true;continue;}
    try{let image=operators.argsArray[i][0];if(typeof image==='string'){const objects=image.startsWith('g_')?page.commonObjs:page.objs;image=await Promise.race([new Promise(resolve=>objects.get(image,resolve)),new Promise((_,reject)=>setTimeout(reject,500))]);}
     const channels=image.data.length/(image.width*image.height);if(![1,3,4].includes(channels))throw Error();const {default:sharp}=await import('sharp');const encoded=await sharp(image.data,{raw:{width:image.width,height:image.height,channels},limitInputPixels:16000000}).png().toBuffer();images.push({url:'embedded:pdf-'+imageCount,hash:await imageSignature(encoded),alt:'原稿图片 '+imageCount});
    }catch{images.push({url:'embedded:pdf-'+imageCount,unreadable:true});unknown=true;}
   }page.cleanup();
  }
  const text=paragraphs.join('\n');if(text.length<20)throw Error('此 PDF 没有可读取的文字，请上传 Word 原稿或可选中文字的 PDF。');
  return {title,text:text.slice(0,100000),links:links.slice(0,300),images,imageCount,imagesUnknown:true,imageLimited:imageCount>16};
 }finally{await task.destroy();}
}
export function originalUrl(value){
 const url=validateUrl(value);
 if(url.hostname!=='docs.google.com'||/^\/document\/d\/e\//.test(url.pathname))return url.href;
 const match=url.pathname.match(/^\/document\/(?:u\/\d+\/)?d\/([\w-]+)(?:\/|$)/);
 if(!match)throw Error('请提供 Google 文档的完整分享链接。');
 const exportUrl=new URL(`https://docs.google.com/document/d/${match[1]}/export?format=docx`);
 if(url.searchParams.has('resourcekey'))exportUrl.searchParams.set('resourcekey',url.searchParams.get('resourcekey'));
 return exportUrl.href;
}
export async function readOriginal(input,signal,{fetchDocument=fetchPublic}={}){
 if(input.file){const name=String(input.file.name||'').slice(0,200),data=String(input.file.data||'');if(data.length>8000000||!/^[A-Za-z0-9+/]*={0,2}$/.test(data))throw Error('稿件格式不正确或超过 6 MB。');return {...await parseDocument(Buffer.from(data,'base64'),name),sourceName:input.originalUrl?String(input.originalUrl).slice(0,2048):name};}
 if(!input.originalUrl)throw Error('请上传原稿文档，或填写可公开访问的原稿链接。');
 const url=originalUrl(input.originalUrl);
 if(new URL(url).hostname==='docs.google.com')return readGoogleOriginal(input.originalUrl,url,signal,fetchDocument);
 const r=await fetchDocument(url,{binary:true,maxBytes:6000000,timeout:9000,signal});
 if(r.status!==200)throw Error('原稿链接暂时无法访问，请开放阅读权限或上传 Word 文档。');
 const name=/format=docx/.test(url)?'original.docx':new URL(r.url).pathname.split('/').pop()||'original.html';
 const result=await parseDocument(r.buffer,name,r.url);if(/sign in|登录|访问权限|request access/i.test(result.title)&&result.text.length<1000)throw Error('原稿链接需要登录，请使用公开链接或上传文档。');return {...result,sourceName:String(input.originalUrl).slice(0,2048)};
}

async function readGoogleOriginal(source,url,signal,fetchDocument){
 const targets=[url];
 // Shared documents also have a lightweight HTML reader; published /d/e links
 // must retain their publication ID instead of being exported as document "e".
 if(new URL(url).searchParams.get('format')==='docx'){
  const mobile=new URL(url);mobile.pathname=mobile.pathname.replace(/\/export$/,'/mobilebasic');mobile.searchParams.delete('format');targets.push(mobile.href);
 }
 let last='network';
 for(const target of targets){
  if(signal?.aborted)break;
  let r;try{r=await fetchDocument(target,{binary:true,maxBytes:6000000,timeout:6500,signal});}catch{last='network';continue;}
  if([401,403].includes(r.status)||new URL(r.url).hostname==='accounts.google.com'){last='permission';continue;}
  if(r.status===404){last='missing';continue;}
  if(r.status!==200){last='network';continue;}
  const zip=r.buffer[0]===0x50&&r.buffer[1]===0x4b;
  const text=zip?'':r.buffer.toString('utf8');
  if(!zip&&(/<title[^>]*>[^<]*(?:sign in|登录|request access|page not found)/i.test(text)||/id=["'](?:identifierId|request-access-button)["']/i.test(text))){last='permission';continue;}
  try{
   const result=await parseDocument(r.buffer,zip?'original.docx':'original.html',r.url);
   if(!zip&&/Google (?:Docs|文档)$/.test(result.title)&&result.text.length<500){last='permission';continue;}
   // Google's HTML reader wraps outgoing anchors in a redirect URL.
   if(!zip)result.links=result.links.map(link=>{try{const u=new URL(link.url);if(['www.google.com','google.com'].includes(u.hostname)&&u.pathname==='/url'){const direct=u.searchParams.get('q')||u.searchParams.get('url');if(direct&&/^https?:\/\//i.test(direct))return {...link,url:validateUrl(direct).href};}}catch{}return link;});
   return {...result,sourceName:String(source).slice(0,2048)};
  }catch{last='format';}
 }
 if(last==='permission')throw Error('谷歌文档需要阅读权限。请使用允许公开阅读的链接，或下载 Word（.docx）后上传。');
 if(last==='missing')throw Error('谷歌文档未找到，请检查分享链接是否完整、文档是否仍存在。');
 if(last==='format')throw Error('谷歌文档内容未能完整读取。请下载 Word（.docx）后上传，保留原稿链接和图片。');
 throw Error('谷歌文档连接失败，暂未读取原稿。请下载 Word（.docx）后上传，或稍后重试。');
}
