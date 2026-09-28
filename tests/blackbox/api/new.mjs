import {get,post,patch,call} from './lib.mjs';
import fs from 'fs';
const S='BBN-'+(Date.now()%1000000).toString(36).toUpperCase();
const own={role:'owner',actor:'usr-owner'}, sup={role:'supervisor',actor:'usr-demo-sup'}, wrk={role:'worker',actor:'usr-demo-wrk'};
const results=[]; let n=0;
const rec=(rule,description,request,expected,actual,verdict)=>results.push({id:'N'+(++n),spec_rule:rule,description,request,expected,actual:typeof actual==='string'?actual:JSON.stringify(actual).slice(0,500),verdict});
const check=(rule,d,req,exp,ok,act)=>rec(rule,d,req,exp,act,ok?'pass':'fail');
const is4xx=s=>s>=400&&s<500;
const MONEY=/(^|_)(rate|rate_per_m|amount|total|margin|cost|cost_per_m|credit_limit|outstanding|overdue|taxable|value|price|quoted_rate|target_rate|selling|profit)(_|$)/i;
function leaks(x,p=''){const o=[];if(Array.isArray(x))x.forEach((v,i)=>o.push(...leaks(v,p+'['+i+']')));else if(x&&typeof x==='object')for(const[k,v]of Object.entries(x)){if(MONEY.test(k)&&v!=null&&v!==''&&(typeof v==='number'||(typeof v==='string'&&/^\d/.test(v))))o.push(p+'.'+k+'='+v);o.push(...leaks(v,p+'.'+k));}else if(typeof x==='string'&&/₹|\bRs\.?\s?\d/.test(x))o.push(p+' str');return o;}
const bal=async lot=>{const l=(await get('/api/stock?role=owner')).body.lots.find(l=>l.lot_id===lot);return l?Number(l.balance):null;};
const IN=(lot,q,m)=>post('/api/stock',{direction:'IN',lot_id:lot,quality:q,design:'D1',grey_meters:m,finished_meters:m,mill_name:'M',moved_by:'usr-owner',...own});
const OUT=(lot,m,party)=>post('/api/stock',{direction:'OUT',lot_id:lot,meters:m,party,moved_by:'usr-owner',...own});
const order=(p,q,m,x={})=>post('/api/orders',{party:p,quality:q,meters:m,rate_per_m:100,promise_date:'2026-12-31',...own,...x}).then(r=>r.body.order);
const oget=id=>get(`/api/orders/${id}?role=owner`);
const reservedOn=async lot=>{ // sum outstanding reservations on lot across all orders
  const os=(await get('/api/orders?role=owner')).body.orders; let s=0;
  for(const o of os){ if(!String(o.quality).startsWith(S)) continue; const g=await oget(o.id); for(const a of g.body.allocations||[]) if(a.lot_id===lot&&a.status==='reserved') s+=Number(a.meters)-Number(a.dispatched_m||0);} return s; };
const P1=S+'-P1',P2=S+'-P2',P3=S+'-P3';
for(const p of [P1,P2,P3]) await post('/api/parties',{name:p,...own});
const run=()=>post('/api/agents/run',{role:'owner'});
const sugs=async()=>(await get('/api/agents/suggestions?role=owner')).body.suggestions||[];

// ---- 1. malformed / empty / array / null / string bodies on every write endpoint ----
{
  const q=S+'-QJ'; await IN(S+'-J1',q,100); const o=await order(P1,q,10);
  const pid=(await get('/api/parties?role=owner&q='+encodeURIComponent(P1))).body.parties[0].id;
  const inq=(await post('/api/inquiries',{raw_text:'need 5 m '+q,...own})).body.inquiry;
  const al=(await post(`/api/orders/${o.id}/allocate`,{lot_id:S+'-J1',meters:5,...own})).body.allocations?.[0];
  const eps=[['POST','/api/stock'],['POST','/api/parties'],['PATCH','/api/parties/'+pid],['POST','/api/rates'],['POST','/api/costs'],['PUT','/api/settings/billing'],
    ['POST','/api/inquiries'],['PATCH','/api/inquiries/'+inq.id],['POST',`/api/inquiries/${inq.id}/convert`],['POST','/api/orders'],['PATCH','/api/orders/'+o.id],
    ['POST',`/api/orders/${o.id}/allocate`],['POST',`/api/allocations/${al?.id}/release`],['POST','/api/dispatches'],['POST','/api/invoices'],['PATCH','/api/invoices/1'],
    ['POST','/api/payments'],['POST','/api/agents/suggestions'],['POST','/api/agents/run'],['POST','/api/chat']];
  for(const [m,u] of eps){
    const st=[]; for(const b of ['{bad json','','[]','null','"str"','[{"role":"owner"}]']) st.push((await call(m,u,b)).status);
    check('Access/bad-input',`${m} ${u} with bodies {bad json | empty | [] | null | "str" | [{role:owner}] → all 4xx`,{method:m,url:u,body:'6 malformed variants'},'all 4xx, no 500',st.every(is4xx),{statuses:st});
  }
  // 2xx side-effect check: the release endpoint must not have released on garbage
  const g=await oget(o.id); const r=(g.body.allocations||[]).filter(a=>a.status==='reserved').reduce((s,a)=>s+Number(a.meters),0);
  check('R6.4','Garbage bodies on release/PATCH did not release or change the allocation',{method:'GET',url:`/api/orders/${o.id}`},'reserved 5, order meters 10',r===5&&Number(g.body.order.meters)===10,{reserved:r,meters:g.body.order.meters});
}

// ---- 2. reserved ≤ balance after every kind of OUT ----
{
  const q=S+'-QR';
  const inv=async(lot,d,req,extra)=>{const b=await bal(lot),r=await reservedOn(lot);check('R6.2',d,req,'reserved ≤ balance afterwards (refuse or reduce reservation)',r<=b,{balance:b,reserved:r,...extra});};
  // a) dispatch without order, other party
  await IN(S+'-R1',q,100); const oa=await order(P1,q,100); await post(`/api/orders/${oa.id}/allocate`,{lot_id:S+'-R1',meters:100,...own});
  let x=await post('/api/dispatches',{party:P2,lines:[{lot_id:S+'-R1',meters:50}],...own});
  await inv(S+'-R1','Dispatch without order (party P2) from lot fully reserved for P1 order',{method:'POST',url:'/api/dispatches',body:{party:P2,lines:[{lot_id:S+'-R1',meters:50}]}},{status:x.status,err:x.body?.error});
  // b) dispatch against another party's order on a lot reserved for order A
  await IN(S+'-R2',q,100); const ob=await order(P1,q,100); await post(`/api/orders/${ob.id}/allocate`,{lot_id:S+'-R2',meters:100,...own});
  const oc=await order(P2,q,60);
  x=await post('/api/dispatches',{party:P2,order_id:oc.id,lines:[{lot_id:S+'-R2',meters:60}],...own});
  await inv(S+'-R2','Dispatch for another party\'s order from lot fully reserved for P1 order',{method:'POST',url:'/api/dispatches',body:{party:P2,order_id:oc.id,lines:[{lot_id:S+'-R2',meters:60}]}},{status:x.status,err:x.body?.error});
  // c) plain /api/stock OUT, party unrelated
  await IN(S+'-R3',q,100); const od=await order(P1,q,100); await post(`/api/orders/${od.id}/allocate`,{lot_id:S+'-R3',meters:100,...own});
  x=await OUT(S+'-R3',70,P3);
  await inv(S+'-R3','Plain /api/stock OUT 70 (party P3) on lot fully reserved for P1 order',{method:'POST',url:'/api/stock',body:{direction:'OUT',lot_id:S+'-R3',meters:70,party:P3}},{status:x.status,err:x.body?.error});
  // d) partial reservation, OUT beyond free
  await IN(S+'-R4',q,100); const oe=await order(P1,q,60); await post(`/api/orders/${oe.id}/allocate`,{lot_id:S+'-R4',meters:60,...own});
  x=await OUT(S+'-R4',50,P3);
  await inv(S+'-R4','Partial: lot 100 with 60 reserved, plain OUT 50 (exceeds free 40)',{method:'POST',url:'/api/stock',body:{direction:'OUT',lot_id:S+'-R4',meters:50,party:P3}},{status:x.status,err:x.body?.error});
  // e) OUT within free
  await IN(S+'-R5',q,100); const of=await order(P1,q,60); await post(`/api/orders/${of.id}/allocate`,{lot_id:S+'-R5',meters:60,...own});
  x=await OUT(S+'-R5',40,P3);
  const b5=await bal(S+'-R5'),r5=await reservedOn(S+'-R5');
  check('R1.2/R6.2','OUT 40 within free 40 (lot 100, 60 reserved) allowed; reservation intact',{method:'POST',url:'/api/stock',body:{direction:'OUT',lot_id:S+'-R5',meters:40,party:P3}},'2xx, balance 60, reserved 60',x.status<300&&b5===60&&r5===60,{status:x.status,balance:b5,reserved:r5});
  // f) parallel mixed: 3 non-order dispatches of 40 on lot 100 with 50 reserved
  await IN(S+'-R6',q,100); const og=await order(P1,q,50); await post(`/api/orders/${og.id}/allocate`,{lot_id:S+'-R6',meters:50,...own});
  const px=await Promise.all([1,2,3].map(()=>post('/api/dispatches',{party:P3,lines:[{lot_id:S+'-R6',meters:40}],...own})));
  await inv(S+'-R6','3 parallel non-order dispatches of 40 on lot 100 with 50 reserved',{method:'POST ×3 parallel',url:'/api/dispatches',body:{party:P3,lines:[{lot_id:S+'-R6',meters:40}]}},{statuses:px.map(r=>r.status)});
}

// ---- 3. supervisor allocate / release ----
{
  const q=S+'-QS'; await IN(S+'-S1',q,200); const o=await order(P1,q,100);
  let r=await post(`/api/orders/${o.id}/allocate`,{lot_id:S+'-S1',meters:80,...sup});
  const lk=leaks(r.body);
  check('Access/R6.1','Supervisor manual allocate 80 → 2xx, no ₹ in response',{method:'POST',url:`/api/orders/${o.id}/allocate`,body:{lot_id:S+'-S1',meters:80,role:'supervisor'}},'2xx, no money',r.status<300&&lk.length===0,{status:r.status,leaks:lk});
  const aid=r.body?.allocations?.[0]?.id ?? (await oget(o.id)).body.allocations?.[0]?.id;
  r=await post(`/api/allocations/${aid}/release`,{role:'worker',actor:'usr-demo-wrk'});
  check('Access','Worker release allocation → 403',{method:'POST',url:`/api/allocations/${aid}/release`,body:{role:'worker'}},'403',r.status===403,{status:r.status});
  r=await post(`/api/allocations/${aid}/release`,{...sup});
  const res=await reservedOn(S+'-S1');
  check('Access/R6.4','Supervisor release → 2xx, reservation gone, no ₹ in response',{method:'POST',url:`/api/allocations/${aid}/release`,body:{role:'supervisor'}},'2xx, reserved 0, no money',r.status<300&&res===0&&leaks(r.body).length===0,{status:r.status,reserved:res,leaks:leaks(r.body)});
  r=await get(`/api/orders/${o.id}/candidates?role=supervisor`);
  check('Access','Supervisor candidates list has no money',{method:'GET',url:`/api/orders/${o.id}/candidates?role=supervisor`},'200, no money',r.status===200&&leaks(r.body).length===0,{status:r.status,leaks:leaks(r.body)});
}

// ---- 4. allocation suggestion visible & acceptable amid many suggestions; freshness ----
{
  // noise: 40 qualities with no stock + open order, and 15 overdue orders
  for(let i=0;i<40;i++) await order(P2,S+'-NOISE'+i,100);
  for(let i=0;i<15;i++) await order(P3,S+'-OV'+i,50,{promise_date:'2026-09-01'});
  const tomorrow=new Date(Date.now()+86400000).toISOString().slice(0,10);
  const q=S+'-QT'; await IN(S+'-T1',q,500);
  const o=await order(P1,q,300,{promise_date:tomorrow});
  await run(); const all=await sugs();
  const forO=all.filter(s=>s.target_type==='order'&&String(s.target_id)===String(o.id));
  const act=forO.find(s=>s.action_label);
  check('R13.1/R5.3','With ≥55 other alerts, order due tomorrow (0 allocated, 500 m free) has an actionable suggestion in the listing',{method:'GET',url:'/api/agents/suggestions?role=owner'},'suggestion for order with action_label',!!act,{total:all.length,forOrder:forO.map(s=>[s.kind,s.action_label,s.title])});
  if(act){
    const r=await post('/api/agents/suggestions',{id:act.id,action:'accept',...own});
    const g=await oget(o.id); const rs=(g.body.allocations||[]).filter(a=>a.status==='reserved').reduce((s,a)=>s+Number(a.meters),0);
    check('R13.3','Accepting it reserves 300 m for the order',{method:'POST',url:'/api/agents/suggestions',body:{id:act.id,action:'accept'}},'reserved 300',rs===300,{status:r.status,reserved:rs});
  } else rec('R13.3','Accept allocation suggestion amid many',{},'reserved 300','no actionable suggestion to accept','fail');
  // freshness: manual allocation then GET listing (R13.1 listing triggers a scan)
  const q2=S+'-QF'; await IN(S+'-F1',q2,500);
  const o2=await order(P1,q2,300,{promise_date:tomorrow});
  await run(); const before=(await sugs()).filter(s=>s.target_type==='order'&&String(s.target_id)===String(o2.id));
  await post(`/api/orders/${o2.id}/allocate`,{lot_id:S+'-F1',meters:300,...own});
  const after=(await sugs()).filter(s=>s.target_type==='order'&&String(s.target_id)===String(o2.id));
  const stale=after.filter(s=>/\b0 m reserved|0% covered|300 m not ready/.test(s.title+' '+s.detail) || s.action_label && /allocat|reserve/i.test(s.action_label));
  check('R13.1','Right after fully allocating the order, listing no longer claims 0 m reserved / offers allocation',{method:'GET',url:'/api/agents/suggestions?role=owner (after allocate)'},'no stale "0 m reserved"/allocate suggestion for order',stale.length===0,{before:before.map(s=>s.title),after:after.map(s=>s.title+' | '+s.detail)});
  await run();
  const after2=(await sugs()).filter(s=>s.target_type==='order'&&String(s.target_id)===String(o2.id)&&/\b0 m reserved|0% covered|300 m not ready/.test(s.title+' '+s.detail));
  check('R13.1','After forced re-scan, no stale 0-reserved alert for the allocated order',{method:'POST /api/agents/run then GET',url:'/api/agents/suggestions'},'none',after2.length===0,after2.map(s=>s.title));
  // accept stale allocate suggestion after manual allocation must not over-reserve
  const q3=S+'-QG'; await IN(S+'-G1',q3,500);
  const o3=await order(P1,q3,300,{promise_date:tomorrow});
  await run(); const s3=(await sugs()).find(s=>s.target_type==='order'&&String(s.target_id)===String(o3.id)&&s.action_label);
  await post(`/api/orders/${o3.id}/allocate`,{lot_id:S+'-G1',meters:300,...own});
  if(s3){ const r=await post('/api/agents/suggestions',{id:s3.id,action:'accept',...own});
    const rs=(await oget(o3.id)).body.allocations.filter(a=>a.status==='reserved').reduce((s,a)=>s+Number(a.meters),0);
    check('R6.3/R13.3','Accepting an allocate suggestion after the order was manually fully allocated does not over-reserve',{method:'POST',url:'/api/agents/suggestions',body:{id:s3.id,action:'accept'}},'reserved stays 300',rs===300&&r.status<500,{status:r.status,reserved:rs});
  } else rec('R13.3','Stale-accept test (no actionable suggestion found)',{},'n/a','none','ambiguous');
  // reject then re-scan (many suggestions) — must stay hidden
  const q4=S+'-QH'; await IN(S+'-H1',q4,500); const o4=await order(P1,q4,300,{promise_date:tomorrow});
  await run(); const s4=(await sugs()).find(s=>s.target_type==='order'&&String(s.target_id)===String(o4.id));
  if(s4){ await post('/api/agents/suggestions',{id:s4.id,action:'reject',...own}); await run();
    const back=(await sugs()).filter(s=>s.kind===s4.kind&&String(s.target_id)===String(o4.id));
    check('R13.3','Rejected order suggestion not back after re-scan',{method:'POST',url:'/api/agents/suggestions',body:{id:s4.id,action:'reject'}},'absent',back.length===0,back.map(s=>s.title));
  }
  // supervisor sees the allocation suggestion (non-money) and it has no money
  const ss=(await get('/api/agents/suggestions?role=supervisor')).body.suggestions||[];
  check('R13.4','Supervisor suggestion list (with many items) has no money',{method:'GET',url:'/api/agents/suggestions?role=supervisor'},'no ₹, no owner_only',leaks(ss).length===0&&ss.every(s=>!s.owner_only),{n:ss.length,leaks:leaks(ss).slice(0,3)});
}

const prev=JSON.parse(fs.readFileSync(new URL('./results_rerun.json', import.meta.url)));
fs.writeFileSync(new URL('./results.json', import.meta.url),JSON.stringify([...prev,...results],null,2));
const c={pass:0,fail:0,ambiguous:0}; results.forEach(r=>c[r.verdict]++); console.log('NEW',c);
for(const r of results.filter(r=>r.verdict!=='pass')) console.log(r.verdict,r.id,r.spec_rule,r.description,'|',JSON.stringify(r.request),'| exp:',r.expected,'| act:',r.actual);
