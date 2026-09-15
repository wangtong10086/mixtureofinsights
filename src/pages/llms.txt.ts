import {getCollection} from 'astro:content';
import {postUrl,slugOf,langOf} from '../i18n';
export async function GET(){
 const posts=await getCollection('blog');
 const lines=['# Mixture of Insights','','> Technical notes by Wang Tong on LLM post-training, agents, OpenVINO inference and systems debugging.','','- [English](https://mixtureofinsights.com/)','- [中文](https://mixtureofinsights.com/zh/)','- [Author](https://mixtureofinsights.com/about/)'];
 for(const lang of ['en','zh'] as const){lines.push('',lang==='en'?'## Articles (English)':'## 文章（中文）');for(const p of posts.filter(p=>langOf(p.id)===lang).sort((a,b)=>a.id.localeCompare(b.id))){lines.push(`- [${p.data.title}](https://mixtureofinsights.com${postUrl(lang,slugOf(p.id))}): ${p.data.description}`);}}
 return new Response(lines.join('\n')+'\n',{headers:{'Content-Type':'text/plain; charset=utf-8'}});
}
