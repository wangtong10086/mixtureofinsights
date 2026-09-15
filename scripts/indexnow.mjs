import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const site='https://mixtureofinsights.com';
export function changedUrls(before,after){return [...new Set([...Object.keys(before.pages),...Object.keys(after.pages)])].filter(u=>before.pages[u]!==after.pages[u]).sort();}
async function get(url){return fetch(url,{signal:AbortSignal.timeout(20000),cache:'no-store'});}
async function main(){
 const mode=process.argv[2];
 if(mode==='snapshot'){
  const r=await get(site+'/seo-manifest.json');let before;
  if(r.ok){before=await r.json();if(before.version!==1||!before.pages)throw Error('Invalid deployed manifest');}
  else if(r.status===404){const index=await (await get(site+'/sitemap-index.xml')).text();const maps=[...index.matchAll(/<loc>(.*?)<\/loc>/g)].map(m=>m[1]);before={version:1,pages:{}};const {createHash}=await import('node:crypto');for(const m of maps){const xml=await (await get(m)).text();for(const match of xml.matchAll(/<loc>(.*?)<\/loc>/g)){const u=match[1];if(new URL(u).origin!==site)throw Error('Unexpected host');const page=await get(u);if(!page.ok)throw Error(`Baseline ${u}: ${page.status}`);before.pages[u]=createHash('sha256').update(await page.text()).digest('hex');}}}
  else throw Error(`Baseline fetch failed: ${r.status}`);
  writeFileSync('work-indexnow-before.json',JSON.stringify(before));return;
 }
 if(mode==='submit'){
  const before=JSON.parse(readFileSync('work-indexnow-before.json','utf8'));const after=JSON.parse(readFileSync('dist/seo-manifest.json','utf8'));
  const urls=changedUrls(before,after);const live=await (await get(site+'/seo-manifest.json')).json();if(JSON.stringify(live)!==JSON.stringify(after))throw Error('Live deployment manifest mismatch; no notification sent');
  if(urls.some(u=>new URL(u).origin!==site)||urls.length>10000)throw Error('Invalid submission scope');
  if(!urls.length){console.log('IndexNow: no changed pages');return;}
  const key=readFileSync('scripts/indexnow-key.txt','utf8').trim();const response=await fetch('https://api.indexnow.org/indexnow',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({host:new URL(site).host,key,keyLocation:site+'/'+key+'.txt',urlList:urls}),signal:AbortSignal.timeout(30000)});
  writeFileSync('indexnow-result.json',JSON.stringify({time:new Date().toISOString(),status:response.status,urls},null,2));
  if(![200,202].includes(response.status))throw Error(`IndexNow ${response.status}: ${await response.text()}`);console.log(`IndexNow accepted ${urls.length} changed URLs (${response.status}); indexing not guaranteed`);
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
