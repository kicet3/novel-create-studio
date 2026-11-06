import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const [buildDir, bodyPath, outPath] = process.argv.slice(2);
const css = readFileSync(join(buildDir, "base.css"), "utf8");
let body = readFileSync(bodyPath, "utf8");

// --- PRD body: anchors, TOC, tables, FR row ids, source badges
const toc = [];
let n = 0;
body = body.replace(/^<h1>[\s\S]*?<\/h1>\n?/, "");
body = body.replace(/<h2>([\s\S]*?)<\/h2>/g, (_, inner) => {
  const id = `prd-s${++n}`;
  toc.push(`<li><a href="#${id}" data-goto="prd">${inner.replace(/<[^>]+>/g, "")}</a></li>`);
  return `<h2 id="${id}">${inner}</h2>`;
});
let h3 = 0;
body = body.replace(/<h3>([\s\S]*?)<\/h3>/g, (_, inner) => `<h3 id="prd-h${++h3}">${inner}</h3>`);
body = body.replace(/<table>/g, '<div class="prd-tbl"><table>').replace(/<\/table>/g, "</table></div>");
const frIds = new Set();
body = body.replace(/<tr>\s*<td>((?:FR|NFR)-[A-Z]+-\d+[a-z]?)<\/td>/g, (m, id) => {
  if (frIds.has(id)) return m;
  frIds.add(id);
  return `<tr id="fr-${id}"><td><span class="fr">${id}</span></td>`;
});
body = body.replace(/\[(1차|2차)\]/g, (_, k) => `<span class="src ${k === "1차" ? "s1" : "s2"}">${k}</span>`);

// --- Mockup screens
const order = ["onboarding", "home", "board", "inbox", "manuscript", "ontology", "foreshadow", "messenger", "media", "settings"];
const files = readdirSync(join(buildDir, "screens")).filter(f => f.endsWith(".html"));
const ids = [...order.filter(id => files.includes(`${id}.html`)), ...files.map(f => f.replace(/\.html$/, "")).filter(id => !order.includes(id))];
const attr = (html, name) => (html.match(new RegExp(`data-${name}="([^"]*)"`)) || [, ""])[1];
const screens = ids.map(id => {
  const html = readFileSync(join(buildDir, "screens", `${id}.html`), "utf8");
  return { id, html, title: attr(html, "title") || id, release: attr(html, "release") };
});
const screenNav = screens.map((s, i) =>
  `<li><a href="#mock-${s.id}" data-screen-link="${s.id}"><span class="num">${String(i + 1).padStart(2, "0")}</span><span class="t">${s.title}</span><span class="rel">${s.release}</span></a></li>`).join("");

const missingFr = new Set();
const screenHtml = screens.map(s => s.html.replace(/<span class="fr">([^<]+)<\/span>/g, (m, txt) => {
  const first = txt.trim().match(/^(?:FR|NFR)-[A-Z]+-\d+[a-z]?/);
  if (first && frIds.has(first[0])) return `<a class="fr" href="#fr-${first[0]}" data-goto="prd">${txt}</a>`;
  if (first) missingFr.add(first[0]);
  return m;
})).join("\n");

const html = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Novel Studio PRD</title>
<style>
${css}
/* ===== Report shell ===== */
.top{position:sticky;top:0;z-index:20;background:color-mix(in srgb,var(--bg) 92%,transparent);backdrop-filter:blur(6px);border-bottom:1px solid var(--border)}
.top-in{max-width:1320px;margin:0 auto;padding:10px 20px;display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.top h1{font-size:15px;margin:0;display:flex;align-items:center;gap:8px}
.top h1 .logo{width:22px;height:22px;border-radius:6px;background:var(--accent);color:var(--accent-text);display:grid;place-items:center;font-size:12px}
.views{display:flex;gap:4px;background:var(--surface-2);border-radius:8px;padding:3px}
.views button{font:inherit;font-size:13px;font-weight:600;border:0;background:transparent;color:var(--muted);padding:5px 12px;border-radius:6px;cursor:pointer}
.views button[aria-selected="true"]{background:var(--surface);color:var(--text);box-shadow:var(--shadow)}
.top .meta{margin-left:auto;font-size:12px;color:var(--muted);display:flex;gap:10px;align-items:center}
#theme{border:1px solid var(--border);background:var(--surface);color:var(--text);border-radius:6px;padding:3px 10px;font:inherit;font-size:12px;cursor:pointer}
.layout{max-width:1320px;margin:0 auto;padding:24px 20px 80px;display:grid;grid-template-columns:250px minmax(0,1fr);gap:32px}
.layout>main{min-width:0}
.side{position:sticky;top:64px;align-self:start;max-height:calc(100vh - 80px);overflow:auto;font-size:13px}
.side h2{font-size:11.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:0 0 8px}
.side ol{list-style:none;margin:0;padding:0}
.side a{display:block;padding:5px 10px;border-left:2px solid var(--border);color:var(--muted);text-decoration:none}
.side a:hover,.side a.is-current{color:var(--accent);border-color:var(--accent)}
.side.scr li a{display:grid;grid-template-columns:22px 1fr;gap:0 6px;padding:7px 10px}
.side.scr .num{font:600 11px/1.6 ui-monospace,Menlo,monospace;color:var(--faint);grid-row:span 2}
.side.scr .rel{font-size:11px;color:var(--faint)}
[hidden]{display:none!important}

/* ===== PRD document ===== */
.hero{border-bottom:1px solid var(--border);padding-bottom:18px;margin-bottom:8px}
.hero h2{font-size:26px;margin:0 0 6px;border:0;padding:0}
.hero p{margin:0;color:var(--muted)}
.legend{display:flex;flex-wrap:wrap;gap:12px;margin-top:10px;font-size:12.5px;color:var(--muted)}
.prd{font-size:14.5px;line-height:1.75;max-width:980px}
.prd h2{font-size:21px;margin:44px 0 12px;padding-top:10px;border-top:1px solid var(--border);scroll-margin-top:70px}
.prd h3{font-size:16.5px;margin:28px 0 10px;scroll-margin-top:70px}
.prd h4{font-size:15px;margin:22px 0 8px}
.prd pre{background:var(--code-bg);border:1px solid var(--border);border-radius:8px;padding:12px 14px;overflow:auto}
.prd pre code{background:none;padding:0}
.prd blockquote{margin:12px 0;padding:4px 14px;border-left:3px solid var(--accent);color:var(--muted)}
.prd-tbl{overflow-x:auto;margin:12px 0;border:1px solid var(--border);border-radius:8px;background:var(--surface)}
.prd table{border-collapse:collapse;width:100%;font-size:13px;line-height:1.6}
.prd th,.prd td{padding:7px 10px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}
.prd th{background:var(--surface-2);font-weight:600;white-space:nowrap}
.prd tr:last-child td{border-bottom:0}
.prd tr[id]{scroll-margin-top:80px}
.prd tr.flash td{animation:flash 1.6s ease-out}
@keyframes flash{0%{background:var(--accent-soft)}100%{background:transparent}}
.src{display:inline-block;font:600 10px/1.5 ui-monospace,Menlo,monospace;border-radius:4px;padding:0 4px;vertical-align:1px}
.src.s1{background:var(--ok-soft);color:var(--ok)}.src.s2{background:var(--warn-soft);color:var(--warn)}
a.fr{text-decoration:none}

/* ===== Mockups view ===== */
.mock-head{margin-bottom:16px}
.mock-head h2{font-size:22px;margin:0 0 4px}
.mock-head p{margin:0;color:var(--muted);font-size:13.5px}
.screen{scroll-margin-top:70px}
.screen-title{display:flex;align-items:baseline;gap:10px;margin:0 0 10px;flex-wrap:wrap}
.screen-title h3{margin:0;font-size:17px}
.pager{display:flex;justify-content:space-between;margin-top:16px;gap:8px}
.app-nav[data-nav]{cursor:pointer}
body.show-all .screen{display:block!important;margin-bottom:40px}

@media (max-width:980px){
  .layout{grid-template-columns:minmax(0,1fr);gap:16px;padding:16px 16px 60px}
  .side{min-width:0}
  .top-in{padding:8px 16px;gap:8px 12px}
  .side{position:static;max-height:none;border-bottom:1px solid var(--border);padding-bottom:12px}
  .side ol{display:flex;flex-wrap:wrap;gap:4px}
  .side a{border:1px solid var(--border);border-radius:6px;padding:3px 8px}
  .side.scr li a{display:flex;gap:6px}
  .side.scr .rel{display:none}
  .top .meta span{display:none}
}
@media print{.top,.side,.pager{display:none}.layout{display:block}[hidden]{display:block!important}.screen{display:block!important;break-before:page}}
</style>
</head>
<body>
<header class="top"><div class="top-in">
  <h1><span class="logo">N</span>novel-create-studio · PRD</h1>
  <div class="views" role="tablist">
    <button role="tab" data-view="prd" aria-selected="true">PRD 문서</button>
    <button role="tab" data-view="mock" aria-selected="false">화면 목업 (${screens.length})</button>
  </div>
  <div class="meta"><span>v0.2 · Draft · 2026-10-27</span><button id="theme" type="button">테마</button></div>
</div></header>

<div class="layout" id="view-prd">
  <nav class="side" aria-label="PRD 목차"><h2>목차</h2><ol>${toc.join("")}</ol></nav>
  <main>
    <div class="hero">
      <h2>novel-create-studio PRD</h2>
      <p>자율 AI 에이전트가 목표한 웹소설을 집필하고, 메신저로 사람의 판단을 받아 반영하며, 그래프 온톨로지로 세계관과 떡밥을 관리하는 제품의 요구사항 문서입니다.</p>
      <div class="legend"><span><span class="fr">FR-…</span> 기능 요구사항(목업에서 클릭하면 이 문서의 해당 행으로 이동)</span><span><span class="src s1">1차</span> 1차 출처</span><span><span class="src s2">2차</span> 2차 출처</span></div>
    </div>
    <article class="prd">${body}</article>
  </main>
</div>

<div class="layout" id="view-mock" hidden>
  <nav class="side scr" aria-label="목업 화면"><h2>화면</h2><ol>${screenNav}</ol>
    <p class="small muted" style="margin-top:12px">목업 안의 왼쪽 메뉴를 눌러도 화면이 바뀝니다. <a href="#" id="show-all">전체 펼쳐 보기</a></p></nav>
  <main>
    <div class="mock-head"><h2>화면 목업</h2><p>PRD 6.9 대시보드·UI와 시나리오 5장을 바탕으로 한 저충실도 목업입니다. 수치와 이름은 예시 데이터입니다. 각 화면 아래 <b>요구사항 대응</b>에서 FR을 누르면 PRD로 이동합니다.</p></div>
    ${screenHtml}
    <div class="pager"><button class="btn" id="prev">← 이전 화면</button><button class="btn" id="next">다음 화면 →</button></div>
  </main>
</div>

<script>
(function(){
  var root=document.documentElement;
  try{var t=localStorage.getItem("prd-theme");if(t)root.setAttribute("data-theme",t)}catch(e){}
  document.getElementById("theme").addEventListener("click",function(){
    var cur=root.getAttribute("data-theme")||(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");
    var next=cur==="dark"?"light":"dark";root.setAttribute("data-theme",next);
    try{localStorage.setItem("prd-theme",next)}catch(e){}
  });
  var screens=[].slice.call(document.querySelectorAll("#view-mock .screen"));
  var ids=screens.map(function(s){return s.getAttribute("data-screen")});
  screens.forEach(function(s){
    var h=document.createElement("div");h.className="screen-title";
    h.innerHTML="<h3></h3><span class=\\"badge violet\\"></span>";
    h.querySelector("h3").textContent=s.getAttribute("data-title")||"";
    h.querySelector(".badge").textContent=s.getAttribute("data-release")||"";
    s.insertBefore(h,s.firstChild);
  });
  var navMap={home:"home",board:"board",inbox:"inbox",manuscript:"manuscript",ontology:"ontology",foreshadow:"foreshadow",media:"media",audit:"settings",settings:"settings"};
  var current=ids[0];
  function setView(v){
    document.getElementById("view-prd").hidden=v!=="prd";
    document.getElementById("view-mock").hidden=v!=="mock";
    [].forEach.call(document.querySelectorAll(".views button"),function(b){b.setAttribute("aria-selected",String(b.getAttribute("data-view")===v))});
  }
  function showScreen(id,scroll){
    if(ids.indexOf(id)<0)id=ids[0];current=id;
    document.body.classList.remove("show-all");
    screens.forEach(function(s){s.hidden=s.getAttribute("data-screen")!==id});
    [].forEach.call(document.querySelectorAll("[data-screen-link]"),function(a){a.classList.toggle("is-current",a.getAttribute("data-screen-link")===id)});
    var i=ids.indexOf(id);
    document.getElementById("prev").disabled=i<=0;document.getElementById("next").disabled=i>=ids.length-1;
    if(scroll)window.scrollTo({top:0});
  }
  function route(){
    var h=decodeURIComponent(location.hash.slice(1));
    if(h.indexOf("mock-")===0){setView("mock");showScreen(h.slice(5),true);return}
    if(h==="mockups"){setView("mock");showScreen(current,true);return}
    setView("prd");
    if(h){var el=document.getElementById(h);if(el){el.scrollIntoView();if(el.tagName==="TR"){el.classList.remove("flash");void el.offsetWidth;el.classList.add("flash")}}}
  }
  [].forEach.call(document.querySelectorAll(".views button"),function(b){b.addEventListener("click",function(){
    location.hash=b.getAttribute("data-view")==="mock"?"mock-"+current:"";if(b.getAttribute("data-view")==="prd"){setView("prd")}
  })});
  document.getElementById("prev").addEventListener("click",function(){var i=ids.indexOf(current);if(i>0)location.hash="mock-"+ids[i-1]});
  document.getElementById("next").addEventListener("click",function(){var i=ids.indexOf(current);if(i<ids.length-1)location.hash="mock-"+ids[i+1]});
  document.getElementById("show-all").addEventListener("click",function(e){e.preventDefault();screens.forEach(function(s){s.hidden=false});document.body.classList.add("show-all")});
  document.addEventListener("click",function(e){
    var n=e.target.closest&&e.target.closest(".app-nav[data-nav]");
    if(n&&navMap[n.getAttribute("data-nav")]&&ids.indexOf(navMap[n.getAttribute("data-nav")])>=0){location.hash="mock-"+navMap[n.getAttribute("data-nav")]}
  });
  window.addEventListener("hashchange",route);
  showScreen(current,false);route();
})();
</script>
</body>
</html>
`;
writeFileSync(outPath, html);
console.log(JSON.stringify({ sections: n, frRows: frIds.size, screens: screens.map(s => s.id), missingFrLinks: [...missingFr], bytes: Buffer.byteLength(html) }));
