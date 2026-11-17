const feeds = {
  hackernews: { name: 'Hacker News', url: 'https://news.ycombinator.com/rss' },
  bbc: { name: 'BBC News', url: 'https://feeds.bbci.co.uk/news/rss.xml' },
  nasa: { name: 'NASA', url: 'https://www.nasa.gov/feed/' },
  solidot: { name: 'Solidot', url: 'https://www.solidot.org/index.rss' }
};

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== 'GET') return new Response('Method not allowed', {status: 405});
    if (url.pathname === '/') return new Response(page, {headers: {'Content-Type':'text/html; charset=utf-8'}});
    if (url.pathname === '/api/sources') return Response.json(feeds);
    const id = /^\/api\/feed\/([a-z]+)$/.exec(url.pathname)?.[1];
    if (!id || !Object.hasOwn(feeds, id)) return new Response('Not found', {status: 404});
    try {
      const upstream = await fetch(feeds[id].url, {redirect:'error', signal:AbortSignal.timeout(8000)});
      if (!upstream.ok || !upstream.body) throw new Error('Upstream unavailable');
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let bytes = 0;
      let xml = '';
      while (true) {
        const {done,value} = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > 2_000_000) {
          await reader.cancel();
          throw new Error('Feed exceeds size limit');
        }
        xml += decoder.decode(value, {stream:true});
      }
      return Response.json({xml:xml + decoder.decode()}, {headers:{'Cache-Control':'private, max-age=120'}});
    } catch {
      return Response.json({error:'暂时无法获取来源，请稍后重试。'}, {status:502});
    }
  }
};

const page = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>OpenFeed</title>
<style>
:root{font-family:system-ui,sans-serif;color:#252d25;background:#f4f5ef;line-height:1.55}*{box-sizing:border-box}body{margin:0}header{border-bottom:1px solid #dbe1d5;background:#fbfcf7}header div,main{max-width:1040px;margin:auto;padding:20px clamp(16px,5vw,48px)}header div{display:flex;justify-content:space-between;align-items:center}strong{font:700 25px Georgia,serif}main{display:grid;grid-template-columns:240px minmax(0,1fr);gap:36px;padding-top:30px}h1,h2,h3,p{margin:0 0 10px}h2{font-size:17px}h3{font-size:18px}p,small{color:#536153}aside{align-self:start}form{display:grid;gap:8px}select,button{font:inherit;border:1px solid #cbd6c8;border-radius:8px;padding:8px 11px;background:white;color:inherit;min-width:0}button{cursor:pointer}button.primary{background:#214d38;color:white;border-color:#214d38}button:disabled{opacity:.55;cursor:default}.toolbar,.row,.actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.toolbar{justify-content:space-between}.row{justify-content:space-between;margin:8px 0}.row button:first-child{flex:1;text-align:left}.row button[aria-pressed=true]{background:#dbe9dc}.actions{margin-top:10px}article{background:#fff;border:1px solid #e0e4da;border-radius:12px;padding:16px;margin-bottom:10px}article[data-read=true]{background:#edf0e9}a{color:#23573f}nav{display:flex;justify-content:space-between;align-items:center;margin-top:12px}#status{min-height:24px;margin:8px 0;font-size:14px}@media(max-width:650px){main{grid-template-columns:1fr;gap:18px}}
</style></head><body><header><div><strong>OpenFeed</strong><span>个人 RSS 阅读器</span></div></header>
<main><aside><h2>订阅源</h2><form id="add"><select id="pick" aria-label="选择 RSS 来源" required><option value="">选择 RSS 来源</option></select><button class="primary">添加订阅</button></form><div id="sources"></div></aside>
<section aria-labelledby="heading"><div class="toolbar"><h1 id="heading">我的信息流</h1><button id="refresh" type="button">刷新</button></div><label><input id="unread" type="checkbox"> 仅未读</label><p id="status" role="status"></p><div id="items"></div><nav id="pages" aria-label="分页"></nav></section></main>
<script type="module">
const $ = id => document.getElementById(id);
const node = (tag, text) => { const el = document.createElement(tag); if (text) el.textContent = text; return el; };
const button = (title, run) => {const el=node('button', title); el.type='button'; el.onclick=run; return el;};
let saved;
try {saved=JSON.parse(localStorage.getItem('openfeed:v1'));} catch {}
const state=saved || {ids:[],cache:{},read:{}};
let catalog={}, active='', pg=0, busy=false;
function save() {
  try {localStorage.setItem('openfeed:v1',JSON.stringify(state));}
  catch {$('status').textContent='浏览器存储不可用，刷新页面后可能丢失数据。';}
}
function httpLink(raw, base) {
  try {const url=new URL(raw,base); return ['http:','https:'].includes(url.protocol)?url.href:'';} catch {return '';}
}
function parse(xml, id) {
  const root=new DOMParser().parseFromString(xml,'application/xml');
  if(root.querySelector('parsererror') || !['rss','feed','RDF'].includes(root.documentElement.localName)) throw new Error('无法解析 RSS');
  const text=(el,names)=>Array.from(el.children).find(child=>names.includes(child.localName))?.textContent.trim() || '';
  const strip=value=>{const doc=new DOMParser().parseFromString(value,'text/html');doc.querySelectorAll('script,style').forEach(el=>el.remove());return doc.body.textContent.trim();};
  const entries=Array.from(root.getElementsByTagName('*')).filter(el=>['item','entry'].includes(el.localName)).slice(0,80);
  const unique=new Map();
  for(const entry of entries){
    const link=Array.from(entry.children).find(el=>el.localName==='link'&&(!el.getAttribute('rel')||el.getAttribute('rel')==='alternate'));
    const raw=link?.getAttribute('href') || link?.textContent.trim();
    const href=raw?httpLink(raw,catalog[id].url):'';
    const title=text(entry,['title']) || '无标题';
    const date=Date.parse(text(entry,['pubDate','published','updated','date'])) || 0;
    const key=id+':'+(text(entry,['guid','id']) || href || title+date);
    if(!unique.has(key)) unique.set(key,{key,id,title,href,date,summary:strip(text(entry,['description','summary','content','encoded'])).slice(0,360)});
  }
  return [...unique.values()];
}
function render(){
  $('pick').replaceChildren(new Option('选择 RSS 来源',''));
  for(const [id,info] of Object.entries(catalog)) if(!state.ids.includes(id)) $('pick').add(new Option(info.name,id));
  $('add').querySelector('button').disabled=busy;
  $('refresh').disabled=busy || !state.ids.length;
  $('sources').replaceChildren();
  const show=id=>{active=id;pg=0;render();};
  const filter=(name,id)=>{const el=button(name,()=>show(id));el.setAttribute('aria-pressed',String(active===id));return el;};
  const all=node('div');all.className='row';all.append(filter('全部来源',''));$('sources').append(all);
  for(const id of state.ids){
    const row=node('div');row.className='row';
    const remove=button('移除',()=>{state.ids=state.ids.filter(x=>x!==id);delete state.cache[id];for(const key of Object.keys(state.read)) if(key.startsWith(id+':')) delete state.read[key];if(active===id)active='';pg=0;save();render();});
    remove.disabled=busy;
    row.append(filter(catalog[id]?.name || id,id),remove);$('sources').append(row);
  }
  const items=state.ids.filter(id=>!active||id===active).flatMap(id=>state.cache[id]||[]).filter(it=>!$('unread').checked||!state.read[it.key]).sort((a,b)=>b.date-a.date);
  const count=Math.max(1,Math.ceil(items.length/12));pg=Math.min(pg,count-1);
  $('items').replaceChildren();$('pages').replaceChildren();
  if(!items.length){$('items').append(node('p',state.ids.length?'没有符合条件的文章。':'从订阅源添加第一个 RSS。'));return;}
  for(const it of items.slice(pg*12,pg*12+12)){
    const card=node('article');card.dataset.read=Boolean(state.read[it.key]);
    const date=it.date?' · '+new Date(it.date).toLocaleString('zh-CN'):'';
    card.append(node('small',(catalog[it.id]?.name || it.id)+date),node('h3',it.title));
    if(it.summary)card.append(node('p',it.summary));
    const actions=node('div');actions.className='actions';
    if(it.href){const link=node('a','打开原文');link.href=it.href;link.target='_blank';link.rel='noopener noreferrer';actions.append(link);}
    actions.append(button(state.read[it.key]?'标为未读':'标为已读',()=>{if(state.read[it.key])delete state.read[it.key];else state.read[it.key]=true;save();render();}));card.append(actions);$('items').append(card);
  }
  const go=delta=>{pg+=delta;render();$('heading').scrollIntoView();};
  const prev=button('上一页',()=>go(-1)),next=button('下一页',()=>go(1));prev.disabled=pg===0;next.disabled=pg+1===count;
  $('pages').append(prev,node('span',pg+1+' / '+count),next);
}
async function refresh(ids){
  if(busy || !ids.length)return;
  busy=true;$('status').textContent='正在刷新…';render();
  const failed=[];
  await Promise.all(ids.map(async id=>{
    try {const response=await fetch('/api/feed/'+encodeURIComponent(id));if(!response.ok)throw new Error();state.cache[id]=parse((await response.json()).xml,id);}
    catch {failed.push(catalog[id]?.name || id);}
  }));
  busy=false;$('status').textContent=failed.length?'刷新失败：'+failed.join('、')+'。保留上次可用内容。':'已更新 '+new Date().toLocaleTimeString('zh-CN');save();render();
}
$('refresh').onclick=()=>refresh(active?[active]:state.ids);
$('unread').onchange=()=>{pg=0;render();};
$('add').onsubmit=event=>{event.preventDefault();const id=$('pick').value;if(busy||!Object.hasOwn(catalog,id)||state.ids.includes(id))return;state.ids.push(id);active=id;pg=0;save();refresh([id]);};
render();
try {const response=await fetch('/api/sources');if(!response.ok)throw new Error();catalog=await response.json();render();if(state.ids.length)refresh(state.ids);}
catch {$('status').textContent='暂时无法加载来源列表。';}
</script></body></html>`;
