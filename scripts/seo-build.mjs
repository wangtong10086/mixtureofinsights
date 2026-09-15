import {readFileSync,writeFileSync,readdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
const site='https://mixtureofinsights.com';
const walk=d=>readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(d,e.name)):[join(d,e.name)]);
const manifest={version:1,pages:{}};const redirects=[];
for(const file of walk('dist').filter(f=>f.endsWith('/index.html')||f.endsWith('\\index.html'))){
 const path='/'+file.replaceAll('\\','/').replace(/^dist\//,'').replace(/index.html$/,'');
 const html=readFileSync(file,'utf8');
 manifest.pages[site+path]=createHash('sha256').update(html).digest('hex');
 if(path!=='/') redirects.push(`${path.slice(0,-1)} ${path} 301`);
 if(!path.startsWith('/zh/')){const old='/en'+(path==='/'?'':path.slice(0,-1));redirects.push(`${old} ${path} 301`,`${old}/ ${path} 301`);}
}
// Explicit legacy URLs only; unknown /en/ URLs remain real 404s.
writeFileSync('dist/_redirects',[...new Set(redirects)].join('\n')+'\n');
writeFileSync('dist/seo-manifest.json',JSON.stringify(manifest,null,2)+'\n');
// Use only explicit publication/update dates from the rendered article metadata.
for(const file of walk('dist').filter(f=>/sitemap-\d+\.xml$/.test(f))){let xml=readFileSync(file,'utf8');xml=xml.replace(/<url>([\s\S]*?)<\/url>/g,(entry,body)=>{const loc=body.match(/<loc>(.*?)<\/loc>/)?.[1];if(!loc)return entry;const f='dist'+new URL(loc).pathname+'index.html';if(!existsSync(f))return entry;const h=readFileSync(f,'utf8');const date=h.match(/property="article:modified_time" content="([^"]+)"/)?.[1]??h.match(/property="article:published_time" content="([^"]+)"/)?.[1];return date?`<url>${body.replace(/<lastmod>.*?<\/lastmod>/,'')}<lastmod>${date}</lastmod></url>`:entry;});writeFileSync(file,xml);}
console.log(`SEO build: ${Object.keys(manifest.pages).length} pages, ${redirects.length} legacy redirects`);
