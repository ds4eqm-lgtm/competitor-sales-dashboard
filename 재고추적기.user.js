// ==UserScript==
// @name         경쟁사 재고 추적기 · GitHub 연동형
// @namespace    https://github.com/
// @version      1.0.0
// @description  공개 상품 페이지에 전달된 재고 정보가 있을 경우 기록합니다. GitHub 토큰은 로컬 Tampermonkey 저장소에만 보관합니다.
// @match        https://smartstore.naver.com/*/products/*
// @match        https://brand.naver.com/*/products/*
// @match        https://*.github.io/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @grant        unsafeWindow
// @connect      api.github.com
// ==/UserScript==
(function(){'use strict';
 const GH='https://api.github.com/repos/';const own=()=>GM_getValue('owner','');const repo=()=>GM_getValue('repo','');const token=()=>GM_getValue('token','');
 const onDashboard=location.hostname.endsWith('.github.io');
 GM_registerMenuCommand('연결 설정 · GitHub 계정/저장소/토큰',()=>{const o=prompt('새 GitHub 저장소의 소유자 계정(영문)',own());if(o===null)return;const r=prompt('저장소 이름 (예: competitor-insight)',repo());if(r===null)return;const t=prompt('GitHub fine-grained 토큰: 이 PC에만 저장 · 외부에 공유하지 마세요',token());if(t===null)return;if(!/^[a-z\d-]+$/i.test(o)||!/^[a-z\d_.-]+$/i.test(r))return alert('계정 또는 저장소 이름을 확인하세요');GM_setValue('owner',o);GM_setValue('repo',r);GM_setValue('token',t);alert('연결 설정 저장됨. 이 창을 새로고침하세요.')});
 GM_registerMenuCommand('연결 상태 확인',()=>alert('저장소: '+own()+'/'+repo()+'\n토큰: '+(token()?'설정됨':'없음')+'\n실제 쓰기 권한은 저장할 때 확인됩니다.'));
 function req(method,url,body){return new Promise((ok,fail)=>GM_xmlhttpRequest({method,url,headers:{'Accept':'application/vnd.github+json','Authorization':'Bearer '+token(),'X-GitHub-Api-Version':'2022-11-28',...(body?{'Content-Type':'application/json'}:{})},data:body?JSON.stringify(body):undefined,timeout:20000,onload:r=>{try{const x=JSON.parse(r.responseText||'{}');r.status>=200&&r.status<300?ok(x):fail(Error('GitHub HTTP '+r.status+': '+String(x.message||'').slice(0,80)))}catch(e){fail(e)}},onerror:()=>fail(Error('네트워크 연결 실패')),ontimeout:()=>fail(Error('GitHub 응답 지연'))}))}
 function api(path){return GH+encodeURIComponent(own())+'/'+encodeURIComponent(repo())+'/contents/'+path}const enc=s=>btoa(unescape(encodeURIComponent(s))),dec=s=>decodeURIComponent(escape(atob(s.replace(/\s+/g,''))));
 async function update(path,fn){if(!own()||!repo()||!token())throw Error('Tampermonkey 연결 설정이 없습니다');for(let i=0;i<12;i++){let obj={},sha;try{const got=await req('GET',api(path)+'?v='+Date.now());sha=got.sha;obj=JSON.parse(dec(got.content||'e30='))}catch(e){if(!/404/.test(e.message))throw e}const next=fn(obj);try{return await req('PUT',api(path),{message:'Update '+path+' via competitor dashboard',content:enc(JSON.stringify(next,null,2)),...(sha?{sha}:{})})}catch(e){if(!/409|422/.test(e.message)||i===11)throw e;await new Promise(r=>setTimeout(r,400+i*400))}}}
 function ghGet(path){return req('GET',api(path)).then(x=>JSON.parse(dec(x.content||'e30=')))}
 if(onDashboard){
  const origin='https://'+own()+'.github.io',prefix='/'+repo()+'/';
  if(!own()||location.origin!==origin||!location.pathname.startsWith(prefix))return;
  window.addEventListener('message',async e=>{
   if(e.source!==window||e.origin!==location.origin||!e.data)return;
   const m=e.data;
   if(m.type==='cs-bridge-ping'){window.postMessage({type:'cs-bridge-ready'},location.origin);return}
   if(m.type!=='cs-write-request')return;
   try{
    if(!['config/products.json','config/settings.json'].includes(m.path))throw Error('허용되지 않은 파일');
    const value=m.value;
    if(m.path==='config/products.json'&&(!Array.isArray(value)||value.length>1000))throw Error('상품 목록 검증 실패');
    if(m.path==='config/settings.json'&&![10,20,30,40,50,60].includes(value.intervalMinutes))throw Error('간격 검증 실패');
    await update(m.path,()=>value);
    window.postMessage({type:'cs-write-result',id:m.id,ok:true},location.origin);
   }catch(err){window.postMessage({type:'cs-write-result',id:m.id,ok:false,error:err.message},location.origin)}
  });
  window.postMessage({type:'cs-bridge-ready'},location.origin);
  if(location.hash==='#collect'){
   (async()=>{try{
    const ps=(await ghGet('config/products.json')).filter(p=>p.enabled&&/^https:\/\/(smartstore|brand)\.naver\.com\//.test(p.url));
    console.info('[경쟁사 추적기] 자동 방문 시작:',ps.length);
    for(let i=0;i<ps.length;i+=4){
     const tabs=ps.slice(i,i+4).map(p=>GM_openInTab(p.url.split('#')[0]+'#autotrack',{active:false,insert:true,setParent:true}));
     await new Promise(r=>setTimeout(r,18000));
     for(const t of tabs){try{t.close()}catch(e){}}
    }
    console.info('[경쟁사 추적기] 자동 방문 완료');document.title='수집 시도 완료 · 대시보드';
   }catch(e){console.warn('[경쟁사 추적기] 자동 방문 실패:',e.message)}})()
  }
  return;
 }
 if(!location.hash.includes('autotrack'))return;
 // 네이버의 공개 상품 페이지가 이미 받은 응답에서 재고를 관찰합니다. 비공개 엔드포인트 접근·접근제한 우회 없음.
 const productId=location.pathname.match(/\/products\/(\d+)/)?.[1];if(!productId||!own()||!repo()||!token())return;
 let captured=false;const started=Date.now();const visited=new WeakSet();
 function extract(data){const counts=[];const seen=new Set();function scan(obj,depth){if(!obj||typeof obj!=='object'||depth>14||visited.has(obj))return;visited.add(obj);if(Array.isArray(obj)){for(const a of obj)scan(a,depth+1);return}if(Object.hasOwn(obj,'stockQuantity')&&Number.isInteger(obj.stockQuantity)&&obj.stockQuantity>=0&&(obj.optionName||obj.optionValue||obj.id||obj.name)){const id=String(obj.id||obj.optionName||obj.optionValue||obj.name),sig=id+':'+obj.stockQuantity;if(!seen.has(sig)){seen.add(sig);counts.push(obj.stockQuantity)}}for(const [k,v]of Object.entries(obj)){if(k==='stockQuantity')continue;if(v&&typeof v==='object')scan(v,depth+1)}}scan(data,0);return counts.length?counts.reduce((a,b)=>a+b,0):null}
 async function saveStock(stock){if(captured)return;captured=true;try{const all=await ghGet('config/products.json');const p=all.find(x=>x.id===productId&&x.enabled&&new URL(x.url).pathname===location.pathname);if(!p)return;let at=new Date().toISOString();await update('data/records.json',old=>{if(!old||Array.isArray(old)||typeof old!=='object')old={};const a=Array.isArray(old[productId])?old[productId]:[];if(!a.some(r=>Math.abs(new Date(r.at)-new Date(at))<60000&&r.stock===stock))a.push({at,stock});old[productId]=a.slice(-1800);return old});console.info('[경쟁사 추적기] 재고 기록 성공:',productId,stock)}catch(e){console.warn('[경쟁사 추적기] 기록 실패:',e.message);captured=false}}
 function consider(body){if(captured)return;try{const stock=extract(body);if(stock!==null)saveStock(stock)}catch(e){console.warn('[경쟁사 추적기] 응답 해석 실패',e)}}
 try{const w=unsafeWindow;const orig=w.fetch;if(orig){w.fetch=function(...args){const out=orig.apply(this,args);out.then(async response=>{try{const url=String(response.url||'');if(!url.includes(productId))return;const type=response.headers?.get('content-type')||'';if(!type.includes('json'))return;consider(await response.clone().json())}catch(e){} });return out}}const X=w.XMLHttpRequest;if(X){const oldOpen=X.prototype.open;X.prototype.open=function(method,url,...args){this.__csUrl=String(url);return oldOpen.call(this,method,url,...args)};const oldSend=X.prototype.send;X.prototype.send=function(...args){if((this.__csUrl||'').includes(productId))this.addEventListener('load',()=>{try{const val=this.responseType==='json'?this.response:JSON.parse(this.responseText);consider(val)}catch(e){}});return oldSend.apply(this,args)}}}catch(e){console.warn('[경쟁사 추적기] 페이지 감지 설치 실패',e)}
 setTimeout(()=>{if(!captured)console.warn('[경쟁사 추적기] 재고 응답 미확인:',productId)},55000);
})();
