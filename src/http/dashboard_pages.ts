/**
 * Phase 3, item 3 — owner web dashboard: HTML shells.
 *
 * Two pages, both fully self-contained (inline <style> and <script>, no
 * subresource fetches):
 *
 * - renderLoginPage(): the ONLY unauthenticated dashboard response. It is a
 *   credential-entry screen and carries zero owner data — no provider names,
 *   no memory content, no user lists. Its script reads the token from a
 *   password field, verifies it against POST-less GET /api/v1/dashboard/ping
 *   with an `Authorization: Bearer` header, keeps it in sessionStorage
 *   (survives reloads, scoped to the tab, cleared when the tab closes —
 *   never localStorage, never a URL, never a cookie), then fetches the real
 *   app shell with the header and swaps the document.
 * - renderAppPage(): the SPA. Served ONLY with a valid Bearer token. Every
 *   API call sends the token in the Authorization header; a 401 drops the
 *   token and reloads back to the login shell.
 *
 * Why inline instead of separate .js/.css files: a browser navigation (and
 * any subresource it triggers) cannot carry an Authorization header, so
 * external assets could not sit behind Bearer auth. Inlining keeps the
 * "every route needs the token" rule exception-free.
 *
 * The safe renderers (escapeHtml, renderSafeMarkdown) are embedded via
 * `.toString()` from src/http/dashboard_render.ts — byte-identical to the
 * unit-tested code.
 */
import { escapeHtml, renderSafeMarkdown } from "./dashboard_render";

/** Client library: the exact tested sources, embedded verbatim. */
const CLIENT_LIB = escapeHtml.toString() + "\n" + renderSafeMarkdown.toString() + "\n";

const CSS = [
  ":root{color-scheme:dark;--bg:#0f1420;--card:#182032;--line:#26314a;--txt:#e8ecf4;--mut:#93a0b8;--acc:#4da3ff;--ok:#3ecf8e;--bad:#ff6b6b;--warn:#ffb020}",
  "*{box-sizing:border-box}",
  "body{margin:0;background:var(--bg);color:var(--txt);font-family:Tahoma,Arial,sans-serif;line-height:1.7}",
  ".wrap{max-width:960px;margin:0 auto;padding:20px}",
  ".card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:12px 0}",
  ".row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
  ".spacer{flex:1}",
  ".muted{color:var(--mut);font-size:.85em}",
  ".badge{display:inline-block;padding:2px 10px;border-radius:20px;font-size:.75em;border:1px solid var(--line)}",
  ".badge.live{background:#123f2b;color:var(--ok);border-color:#1f6b47}",
  ".badge.off{background:#3d1d1d;color:var(--bad);border-color:#6b2a2a}",
  "button{background:var(--acc);color:#06121f;border:0;border-radius:8px;padding:8px 14px;cursor:pointer;font-family:inherit;font-weight:700}",
  "button.ghost{background:transparent;color:var(--acc);border:1px solid var(--acc)}",
  "button.danger{background:transparent;color:var(--bad);border:1px solid var(--bad)}",
  "button:disabled{opacity:.5;cursor:default}",
  "input,select{background:#0c1120;color:var(--txt);border:1px solid var(--line);border-radius:8px;padding:8px 12px;font-family:inherit}",
  "nav{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0}",
  "nav button{background:transparent;color:var(--txt);border:1px solid var(--line)}",
  "nav button.on{background:var(--acc);color:#06121f;border-color:var(--acc)}",
  "table{width:100%;border-collapse:collapse;font-size:.9em}",
  "th,td{border:1px solid var(--line);padding:8px;text-align:start}",
  "th{background:#111a2c}",
  ".report table{margin:12px 0}",
  ".report pre{background:#0c1120;border:1px solid var(--line);border-radius:8px;padding:12px;overflow:auto;direction:ltr;text-align:left}",
  ".report code{background:#0c1120;padding:1px 6px;border-radius:4px;direction:ltr;display:inline-block}",
  ".login{max-width:380px;margin:15vh auto}",
  ".login input{width:100%;margin:8px 0}",
  ".login button{width:100%}",
  ".err{color:var(--bad)}",
  ".mem{border-bottom:1px solid var(--line);padding:10px 0}",
  ".mem-key{font-weight:700;color:var(--acc)}",
  ".mem-body{white-space:pre-wrap;word-break:break-word}",
  "h1{font-size:1.3em;margin:.2em 0}",
  "h2{font-size:1.1em}",
].join("\n");

/** The credential-entry screen. No owner data — safe to serve unauthenticated. */
export function renderLoginPage(): string {
  return (
    "<!DOCTYPE html>\n" +
    '<html lang="fa" dir="rtl">\n' +
    "<head>\n" +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
    "<title>BOBI — داشبورد مالک</title>\n" +
    "<style>" + CSS + "</style>\n" +
    "</head>\n" +
    "<body>\n" +
    '<div class="wrap login">\n' +
    '<div class="card">\n' +
    "<h1>داشبورد مالک بابی</h1>\n" +
    '<p class="muted">BOBI owner dashboard — ورود با توکن</p>\n' +
    '<form id="f" hidden>\n' +
    '<input type="password" id="tok" dir="ltr" placeholder="BOBI_API_TOKEN" autocomplete="off" autocapitalize="off">\n' +
    "<button>" + "ورود" + "</button>\n" +
    '<p id="err" class="err" hidden></p>\n' +
    '<p class="muted">توکن فقط در حافظهٔ همین تب نگه داشته می‌شود (sessionStorage) و هرگز در آدرس صفحه قرار نمی‌گیرد.</p>\n' +
    "</form>\n" +
    '<p id="wait" class="muted">در حال بررسی نشست…</p>\n' +
    "</div>\n" +
    "</div>\n" +
    "<script>\n" +
    "'use strict';\n" +
    "var KEY='bobi_dash_token';\n" +
    "function showForm(msg){\n" +
    "  document.getElementById('wait').hidden=true;\n" +
    "  var f=document.getElementById('f');f.hidden=false;\n" +
    "  var e=document.getElementById('err');\n" +
    "  if(msg){e.textContent=msg;e.hidden=false;}else{e.hidden=true;}\n" +
    "}\n" +
    "function ping(t){\n" +
    "  return fetch('/api/v1/dashboard/ping',{headers:{'Authorization':'Bearer '+t}}).then(function(r){return r.ok;}).catch(function(){return false;});\n" +
    "}\n" +
    "function loadApp(t){\n" +
    "  fetch('/dashboard',{headers:{'Authorization':'Bearer '+t}}).then(function(r){\n" +
    "    if(!r.ok){sessionStorage.removeItem(KEY);showForm('توکن معتبر نیست.');return;}\n" +
    "    r.text().then(function(html){document.open();document.write(html);document.close();});\n" +
    "  }).catch(function(){showForm('ارتباط با سرور برقرار نشد.');});\n" +
    "}\n" +
    "document.getElementById('f').addEventListener('submit',function(ev){\n" +
    "  ev.preventDefault();\n" +
    "  var t=document.getElementById('tok').value.trim();\n" +
    "  if(!t){showForm('توکن را وارد کنید.');return;}\n" +
    "  document.getElementById('tok').value='';\n" +
    "  ping(t).then(function(ok){\n" +
    "    if(ok){try{sessionStorage.setItem(KEY,t);}catch(e){}\n" +
    "      loadApp(t);\n" +
    "    }else{showForm('توکن معتبر نیست.');}\n" +
    "  });\n" +
    "});\n" +
    "(function(){\n" +
    "  var t=null;try{t=sessionStorage.getItem(KEY);}catch(e){}\n" +
    "  if(!t){showForm();return;}\n" +
    "  ping(t).then(function(ok){if(ok){loadApp(t);}else{try{sessionStorage.removeItem(KEY);}catch(e){}showForm();}});\n" +
    "})();\n" +
    "</script>\n" +
    "</body>\n" +
    "</html>\n"
  );
}
/** The SPA shell. Served ONLY behind a valid Bearer token. */
export function renderAppPage(): string {
  return (
    "<!DOCTYPE html>\n" +
    '<html lang="fa" dir="rtl">\n' +
    "<head>\n" +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
    "<title>BOBI — داشبورد مالک</title>\n" +
    "<style>" + CSS + "</style>\n" +
    "</head>\n" +
    "<body>\n" +
    '<div class="wrap"><div id="app"><p class="muted">در حال بارگذاری…</p></div></div>\n' +
    "<script>\n" +
    CLIENT_LIB +
    APP_JS +
    "</script>\n" +
    "</body>\n" +
    "</html>\n"
  );
}

/**
 * The dashboard SPA. Plain script, no backticks and no ${} sequences so it
 * nests safely inside the TypeScript template above. Every owner-controlled
 * string goes through esc() (the embedded escapeHtml) before it reaches
 * innerHTML — the JSON APIs return data, never markup.
 */
const APP_JS = [
  "'use strict';",
  "var TOKEN_KEY='bobi_dash_token';",
  "var LANG_KEY='bobi_dash_lang';",
  "var token=null;try{token=sessionStorage.getItem(TOKEN_KEY);}catch(e){}",
  "if(!token){window.location.reload();}",
  "var lang='fa';try{if(sessionStorage.getItem(LANG_KEY)==='en')lang='en';}catch(e){}",
  "var esc=escapeHtml;",
  "var md2html=renderSafeMarkdown;",
  "",
  "var STR={",
  "fa:{title:'داشبورد مالک بابی',logout:'خروج',tabP:'پروایدرها',tabM:'حافظه',tabU:'کاربران',tabB:'بنچ‌مارک‌ها',",
  "hintAi:'افزودن پروایدر جدید و وارد کردن کلید، فقط از تلگرام انجام می‌شود: در چت با بابی دستور /ai را بزنید. کلیدها هرگز وارد مرورگر نمی‌شوند.',",
  "live:'فعال — در حال استفاده',isOff:'غیرفعال',pOn:'فعال‌سازی',pOff:'غیرفعال‌سازی',pSet:'انتخاب به‌عنوان فعال',",
  "keySet:'کلید ثبت شده',keyUnset:'بدون کلید',models:'مدل‌ها',mSet:'فعال‌سازی',",
  "memPh:'جست‌وجو در کلید و متن حافظه…',memGo:'جست‌وجو',memEmpty:'حافظه‌ای ثبت نشده است.',memFound:'{n} حافظه',",
  "cUser:'شناسه',cUname:'نام کاربری',cName:'نام',cState:'وضعیت',cAct:'اقدام',",
  "stPending:'در انتظار',stApproved:'تأییدشده',stRejected:'بن‌شده',stRevoked:'میوت‌شده',",
  "aBan:'بن',aUnban:'رفع بن',aMute:'میوت',aUnmute:'رفع میوت',",
  "manualPh:'شناسه عددی کاربر',manualGo:'اجرا',",
  "bTitle:'اجراهای بنچ‌مارک',bEmpty:'هنوز اجرایی ثبت نشده است.',bView:'مشاهده گزارش',bBack:'بازگشت به فهرست',",
  "loading:'در حال بارگذاری…',err:'خطا: ',ok:'انجام شد.',",
  "cfOff:'این پروایدر غیرفعال شود؟',cfBan:'کاربر {id} بن شود؟',cfMute:'کاربر {id} میوت شود؟',",
  "langName:'English'},",
  "en:{title:'BOBI Owner Dashboard',logout:'Log out',tabP:'Providers',tabM:'Memory',tabU:'Users',tabB:'Benchmarks',",
  "hintAi:'Adding a provider or entering a key is Telegram-only: send /ai to Bobi in chat. Keys never enter the browser.',",
  "live:'active — in use',isOff:'disabled',pOn:'Enable',pOff:'Disable',pSet:'Set active',",
  "keySet:'key set',keyUnset:'no key',models:'Models',mSet:'Activate',",
  "memPh:'Search memory keys and content…',memGo:'Search',memEmpty:'No memories stored.',memFound:'{n} memories',",
  "cUser:'ID',cUname:'Username',cName:'Name',cState:'State',cAct:'Actions',",
  "stPending:'pending',stApproved:'approved',stRejected:'banned',stRevoked:'muted',",
  "aBan:'Ban',aUnban:'Unban',aMute:'Mute',aUnmute:'Unmute',",
  "manualPh:'numeric user id',manualGo:'Apply',",
  "bTitle:'Benchmark runs',bEmpty:'No runs recorded yet.',bView:'View report',bBack:'Back to list',",
  "loading:'Loading…',err:'Error: ',ok:'Done.',",
  "cfOff:'Disable this provider?',cfBan:'Ban user {id}?',cfMute:'Mute user {id}?',",
  "langName:'فارسی'}",
  "};",
  "function T(k,v){var p=STR[lang]||STR.fa;var s=p[k]||STR.fa[k]||k;",
  "if(v){for(var n in v){if(Object.prototype.hasOwnProperty.call(v,n)){s=s.split('{'+n+'}').join(String(v[n]));}}",
  "return s;}",
  "",
  "function api(path,opts){",
  "opts=opts||{};var headers={'Authorization':'Bearer '+token};var body;",
  "if(opts.body!==undefined){headers['Content-Type']='application/json';body=JSON.stringify(opts.body);}",
  "return fetch('/api/v1/dashboard'+path,{method:opts.method||'GET',headers:headers,body:body}).then(function(res){",
  "if(res.status===401){try{sessionStorage.removeItem(TOKEN_KEY);}catch(e){}window.location.reload();throw new Error('unauthorized');}",
  "return res.json().then(function(j){return{status:res.status,body:j};});",
  "});}",
  "",
  "var tab='providers';var cache={};var benchName=null;var memQuery='';",
  "function fmtDate(ms){try{return new Date(ms).toLocaleString(lang==='fa'?'fa-IR':'en-US');}catch(e){return String(ms);}}",
  "",
  "function setTab(t){tab=t;benchName=null;render();load();}",
  "function setLang(l){lang=l;try{sessionStorage.setItem(LANG_KEY,l);}catch(e){}",
  "document.documentElement.lang=l;document.documentElement.dir=(l==='fa'?'rtl':'ltr');render();load();}",
  "",
  "function header(){",
  "var h='<div class=\"row\"><h1>'+esc(T('title'))+'</h1><div class=\"spacer\"></div>';",
  "h+='<button class=\"ghost\" data-action=\"lang\">'+esc(T('langName'))+'</button>';",
  "h+='<button class=\"ghost\" data-action=\"logout\">'+esc(T('logout'))+'</button></div>';",
  "h+='<nav>';",
  "h+='<button data-action=\"tab\" data-t=\"providers\"'+(tab==='providers'?' class=\"on\"':'')+'>'+esc(T('tabP'))+'</button>';",
  "h+='<button data-action=\"tab\" data-t=\"memory\"'+(tab==='memory'?' class=\"on\"':'')+'>'+esc(T('tabM'))+'</button>';",
  "h+='<button data-action=\"tab\" data-t=\"users\"'+(tab==='users'?' class=\"on\"':'')+'>'+esc(T('tabU'))+'</button>';",
  "h+='<button data-action=\"tab\" data-t=\"benchmarks\"'+(tab==='benchmarks'?' class=\"on\"':'')+'>'+esc(T('tabB'))+'</button>';",
  "h+='</nav>';return h;}",
  "",
  "function render(){",
  "var el=document.getElementById('app');var h=header();",
  "if(tab==='providers')h+=viewProviders();",
  "else if(tab==='memory')h+=viewMemory();",
  "else if(tab==='users')h+=viewUsers();",
  "else h+=viewBench();",
  "el.innerHTML=h;bindMem();bindUserForm();}",
  "",
  "function load(){",
  "if(tab==='providers'&&!cache.providers){api('/providers').then(function(r){if(r.status===200){cache.providers=r.body;render();}else{showErr(r);}}).catch(netErr);}",
  "else if(tab==='memory'){loadMemory();}",
  "else if(tab==='users'&&!cache.users){api('/users').then(function(r){if(r.status===200){cache.users=r.body;render();}else{showErr(r);}}).catch(netErr);}",
  "else if(tab==='benchmarks'&&!cache.bench){api('/benchmarks').then(function(r){if(r.status===200){cache.bench=r.body;render();}else{showErr(r);}}).catch(netErr);}",
  "}",
  "function netErr(){var el=document.getElementById('app');if(el)el.innerHTML=header()+'<p class=\"err\">'+esc(T('err'))+'network</p>';}",
  "function showErr(r){var el=document.getElementById('app');var m=(r.body&&r.body.error)||('http '+r.status);if(el)el.innerHTML=header()+'<p class=\"err\">'+esc(T('err')+m)+'</p>';}",
  "function refreshProviders(){delete cache.providers;load();}",
  "",
  "// ---- providers ----",
  "function viewProviders(){",
  "var d=cache.providers;if(!d)return '<p class=\"muted\">'+esc(T('loading'))+'</p>';",
  "var h='<div class=\"card\"><p class=\"muted\">'+esc(T('hintAi'))+'</p></div>';",
  "var rt=d.runtime||{};",
  "for(var i=0;i<d.providers.length;i++){var p=d.providers[i];h+=providerCard(p,rt);}",
  "return h;}",
  "function providerCard(p,rt){",
  "var h='<div class=\"card\"><div class=\"row\"><strong>'+esc(p.label)+'</strong>';",
  "if(rt.activeProviderId===p.id)h+=' <span class=\"badge live\">'+esc(T('live'))+'</span>';",
  "if(!p.enabled)h+=' <span class=\"badge off\">'+esc(T('isOff'))+'</span>';",
  "h+='<div class=\"spacer\"></div>';",
  "h+='<button class=\"ghost\" data-action=\"p-toggle\" data-id=\"'+p.id+'\" data-en=\"'+(p.enabled?0:1)+'\">'+esc(p.enabled?T('pOff'):T('pOn'))+'</button>';",
  "if(p.enabled&&rt.activeProviderId!==p.id)h+='<button data-action=\"p-set\" data-id=\"'+p.id+'\">'+esc(T('pSet'))+'</button>';",
  "h+='</div>';",
  "h+='<div class=\"muted\">'+esc(p.adapterLabel)+' · <span dir=\"ltr\">'+esc(p.baseUrl)+'</span></div>';",
  "h+='<div class=\"muted\">'+esc(p.hasCredential?T('keySet'):T('keyUnset'))+' · '+esc(T('models'))+': '+p.models.length+'</div>';",
  "h+='<div style=\"margin-top:8px\">';",
  "for(var j=0;j<p.models.length;j++){var m=p.models[j];h+=modelRow(m,rt);}",
  "h+='</div></div>';return h;}",
  "function modelRow(m,rt){",
  "var h='<div class=\"row\" style=\"padding:4px 0;border-top:1px solid var(--line)\">';",
  "h+='<span>'+esc(m.label)+'</span> <span class=\"muted\" dir=\"ltr\">'+esc(m.modelId)+'</span>';",
  "if(rt.activeModelId===m.id)h+=' <span class=\"badge live\">'+esc(T('live'))+'</span>';",
  "if(!m.enabled)h+=' <span class=\"badge off\">'+esc(T('isOff'))+'</span>';",
  "h+='<div class=\"spacer\"></div>';",
  "h+='<button class=\"ghost\" data-action=\"m-toggle\" data-id=\"'+m.id+'\" data-en=\"'+(m.enabled?0:1)+'\">'+esc(m.enabled?T('pOff'):T('pOn'))+'</button>';",
  "if(m.enabled&&rt.activeModelId!==m.id)h+='<button class=\"ghost\" data-action=\"m-set\" data-id=\"'+m.id+'\">'+esc(T('mSet'))+'</button>';",
  "h+='</div>';return h;}",
  "",
  "// ---- memory (read-only) ----",
  "function viewMemory(){",
  "var h='<div class=\"card\"><form id=\"memf\" class=\"row\">';",
  "h+='<input id=\"memq\" style=\"flex:1\" placeholder=\"'+esc(T('memPh'))+'\" value=\"'+esc(memQuery)+'\">';",
  "h+='<button>'+esc(T('memGo'))+'</button></form></div>';",
  "var d=cache.memory;",
  "if(!d)return h+'<p class=\"muted\">'+esc(T('loading'))+'</p>';",
  "h+='<p class=\"muted\">'+esc(T('memFound',{n:d.mems.length}))+'</p>';",
  "if(d.mems.length===0)return h+'<p class=\"muted\">'+esc(T('memEmpty'))+'</p>';",
  "for(var i=0;i<d.mems.length;i++){var m=d.mems[i];",
  "h+='<div class=\"card mem\"><div class=\"mem-key\">'+esc(m.key)+'</div>';",
  "h+='<div class=\"mem-body\">'+esc(m.content)+'</div>';",
  "h+='<div class=\"muted\">'+esc(fmtDate(m.updatedAt))+'</div></div>';}",
  "return h;}",
  "function loadMemory(){",
  "var q='/memory?limit=100'+(memQuery?'&q='+encodeURIComponent(memQuery):'');",
  "api(q).then(function(r){if(r.status===200){cache.memory=r.body;render();}else{showErr(r);}}).catch(netErr);}",
  "function bindMem(){var f=document.getElementById('memf');if(f)f.addEventListener('submit',function(ev){ev.preventDefault();var i=document.getElementById('memq');memQuery=i?i.value:'';delete cache.memory;loadMemory();});}",
  "",
  "// ---- users / bans ----",
  "function viewUsers(){",
  "var h='<div class=\"card\"><form id=\"uf\" class=\"row\">';",
  "h+='<input id=\"uid\" dir=\"ltr\" placeholder=\"'+esc(T('manualPh'))+'\" inputmode=\"numeric\">';",
  "h+='<select id=\"uact\"><option value=\"ban\">'+esc(T('aBan'))+'</option><option value=\"mute\">'+esc(T('aMute'))+'</option><option value=\"unban\">'+esc(T('aUnban'))+'</option><option value=\"unmute\">'+esc(T('aUnmute'))+'</option></select>';",
  "h+='<button>'+esc(T('manualGo'))+'</button></form></div>';",
  "var d=cache.users;if(!d)return h+'<p class=\"muted\">'+esc(T('loading'))+'</p>';",
  "var states=['pending','approved','rejected','revoked'];",
  "for(var s=0;s<states.length;s++){var st=states[s];var list=d.groups[st]||[];",
  "h+='<div class=\"card\"><h2>'+esc(T('st'+st[0].toUpperCase()+st.slice(1)))+' ('+list.length+')</h2>';",
  "if(list.length===0){h+='<p class=\"muted\">—</p>';}else{",
  "h+='<table><tr><th>'+esc(T('cUser'))+'</th><th>'+esc(T('cUname'))+'</th><th>'+esc(T('cName'))+'</th><th>'+esc(T('cAct'))+'</th></tr>';",
  "for(var i=0;i<list.length;i++){var u=list[i];h+=userRow(u);}",
  "h+='</table>';}",
  "h+='</div>';}",
  "return h;}",
  "function userRow(u){",
  "var h='<tr><td dir=\"ltr\">'+esc(u.userId)+'</td><td dir=\"ltr\">'+esc(u.username||'—')+'</td><td>'+esc(u.firstName||'—')+'</td><td>';",
  "h+='<button class=\"danger ghost\" data-action=\"u-ban\" data-uid=\"'+esc(u.userId)+'\">'+esc(T('aBan'))+'</button> ';",
  "h+='<button class=\"ghost\" data-action=\"u-mute\" data-uid=\"'+esc(u.userId)+'\">'+esc(T('aMute'))+'</button> ';",
  "h+='<button class=\"ghost\" data-action=\"u-unban\" data-uid=\"'+esc(u.userId)+'\">'+esc(T('aUnban'))+'</button> ';",
  "h+='<button class=\"ghost\" data-action=\"u-unmute\" data-uid=\"'+esc(u.userId)+'\">'+esc(T('aUnmute'))+'</button>';",
  "h+='</td></tr>';return h;}",
  "function restrict(uid,action){",
  "api('/users/restrict',{method:'POST',body:{action:action,userId:uid}}).then(function(r){",
  "if(r.status===200){delete cache.users;tab='users';render();load();}else{alert(T('err')+((r.body&&r.body.error)||r.status));}",
  "}).catch(function(){alert(T('err')+'network');});}",
  "function bindUserForm(){var f=document.getElementById('uf');if(!f)return;",
  "f.addEventListener('submit',function(ev){ev.preventDefault();",
  "var uid=document.getElementById('uid').value.trim();var act=document.getElementById('uact').value;",
  "if(!uid)return;if((act==='ban'&&!confirm(T('cfBan',{id:uid})))||(act==='mute'&&!confirm(T('cfMute',{id:uid}))))return;",
  "restrict(uid,act);});}",
  "",
  "// ---- benchmarks ----",
  "function viewBench(){",
  "if(benchName){var r=cache['report:'+benchName];",
  "if(!r)return '<p class=\"muted\">'+esc(T('loading'))+'</p>';",
  "return '<div class=\"card\"><button class=\"ghost\" data-action=\"b-back\">'+esc(T('bBack'))+'</button></div><div class=\"card report\">'+md2html(r.markdown||'')+'</div>';}",
  "var d=cache.bench;if(!d)return '<p class=\"muted\">'+esc(T('loading'))+'</p>';",
  "var h='<div class=\"card\"><h2>'+esc(T('bTitle'))+'</h2>';",
  "if(d.runs.length===0)return h+'<p class=\"muted\">'+esc(T('bEmpty'))+'</p></div>';",
  "h+='<table><tr><th>'+esc(lang==='fa'?'اجرا':'run')+'</th><th>'+esc(lang==='fa'?'حالت':'mode')+'</th><th>'+esc(lang==='fa'?'مدل':'model')+'</th><th>'+esc(lang==='fa'?'امتیاز':'score')+'</th><th></th></tr>';",
  "for(var i=0;i<d.runs.length;i++){var b=d.runs[i];var t=b.totals||{};",
  "h+='<tr><td dir=\"ltr\">'+esc(b.name)+'</td><td>'+esc(b.mode||'—')+'</td><td dir=\"ltr\">'+esc(b.model||'—')+'</td>';",
  "h+='<td>'+(t.avgScorePct!==undefined?esc(String(t.avgScorePct))+'٪':'—')+'</td>';",
  "h+='<td><button class=\"ghost\" data-action=\"b-view\" data-name=\"'+esc(b.name)+'\">'+esc(T('bView'))+'</button></td></tr>';}",
  "return h+'</table></div>';}",
  "",
  "// ---- events ----",
  "document.addEventListener('click',function(e){",
  "var el=e.target&&e.target.closest?e.target.closest('[data-action]'):null;if(!el)return;",
  "var a=el.getAttribute('data-action');",
  "if(a==='tab'){setTab(el.getAttribute('data-t'));}",
  "else if(a==='logout'){try{sessionStorage.removeItem(TOKEN_KEY);}catch(x){}window.location.reload();}",
  "else if(a==='lang'){setLang(lang==='fa'?'en':'fa');}",
  "else if(a==='p-toggle'){var en=el.getAttribute('data-en')==='1';var id=parseInt(el.getAttribute('data-id'),10);",
  "if(!en&&!confirm(T('cfOff')))return;",
  "api('/providers/enable',{method:'POST',body:{id:id,enabled:en}}).then(function(r){if(r.status===200)refreshProviders();else alert(T('err')+((r.body&&r.body.error)||r.status));});}",
  "else if(a==='p-set'){var pid=parseInt(el.getAttribute('data-id'),10);",
  "api('/providers/activate',{method:'POST',body:{id:pid}}).then(function(r){if(r.status===200)refreshProviders();else alert(T('err')+((r.body&&r.body.error)||r.status));});}",
  "else if(a==='m-toggle'){var men=el.getAttribute('data-en')==='1';var mid=parseInt(el.getAttribute('data-id'),10);",
  "api('/models/enable',{method:'POST',body:{id:mid,enabled:men}}).then(function(r){if(r.status===200)refreshProviders();else alert(T('err')+((r.body&&r.body.error)||r.status));});}",
  "else if(a==='m-set'){var msid=parseInt(el.getAttribute('data-id'),10);",
  "api('/models/activate',{method:'POST',body:{id:msid}}).then(function(r){if(r.status===200)refreshProviders();else alert(T('err')+((r.body&&r.body.error)||r.status));});}",
  "else if(a==='u-ban'){var bu=el.getAttribute('data-uid');if(confirm(T('cfBan',{id:bu})))restrict(bu,'ban');}",
  "else if(a==='u-mute'){var mu=el.getAttribute('data-uid');if(confirm(T('cfMute',{id:mu})))restrict(mu,'mute');}",
  "else if(a==='u-unban'){restrict(el.getAttribute('data-uid'),'unban');}",
  "else if(a==='u-unmute'){restrict(el.getAttribute('data-uid'),'unmute');}",
  "else if(a==='b-view'){benchName=el.getAttribute('data-name');render();",
  "api('/benchmarks/report?name='+encodeURIComponent(benchName)).then(function(r){if(r.status===200){cache['report:'+benchName]=r.body;render();}else{alert(T('err')+((r.body&&r.body.error)||r.status));benchName=null;render();}});}",
  "else if(a==='b-back'){benchName=null;render();}",
  "});",
  "",
  "render();load();",
].join("\n");
