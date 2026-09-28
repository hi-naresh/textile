import {get,post,patch,call} from './lib.mjs';
import fs from 'fs';
const S = 'BBA-' + (Date.now()%1000000).toString(36).toUpperCase();
const own={role:'owner',actor:'usr-owner'}, sup={role:'supervisor',actor:'usr-demo-sup'}, wrk={role:'worker',actor:'usr-demo-wrk'};
const results=[]; let n=0;
function rec(rule, description, request, expected, actual, verdict){
  results.push({id:'T'+(++n), spec_rule:rule, description, request, expected, actual: typeof actual==='string'?actual:JSON.stringify(actual).slice(0,400), verdict});
}
const is4xx=s=>s>=400&&s<500;
function check(rule, desc, request, expected, ok, actual){ rec(rule,desc,request,expected,actual, ok?'pass':'fail'); return ok; }
const MONEY=/(^|_)(rate|rate_per_m|amount|total|margin|cost|cost_per_m|credit_limit|outstanding|overdue|taxable|value|price|quoted_rate|target_rate|selling|invoice_total|profit|due)(_|$)/i;
function moneyLeaks(x, path=''){
  const out=[];
  if(Array.isArray(x)) x.forEach((v,i)=>out.push(...moneyLeaks(v,path+'['+i+']')));
  else if(x && typeof x==='object') for(const [k,v] of Object.entries(x)){
    if(MONEY.test(k) && v!==null && v!==undefined && v!=='' && (typeof v==='number' || (typeof v==='string' && /^\d/.test(v)))) out.push(path+'.'+k+'='+v);
    out.push(...moneyLeaks(v,path+'.'+k));
  } else if(typeof x==='string' && /₹|\bRs\.?\s?\d|INR/.test(x)) out.push(path+' str:'+x.slice(0,80));
  return out;
}
const stock=async()=> (await get('/api/stock?role=owner')).body.lots;
const bal=async(lot)=> { const l=(await stock()).find(l=>l.lot_id===lot); return l? Number(l.balance): null; };
async function IN(lot, q, m, extra={}){ return post('/api/stock',{direction:'IN',lot_id:lot,quality:q,design:'D1',grey_meters:m,finished_meters:m,mill_name:'BBA-Mill',moved_by:'usr-owner',...own,...extra}); }
async function OUT(lot, m, extra={}){ return post('/api/stock',{direction:'OUT',lot_id:lot,meters:m,party:S+'-P1',moved_by:'usr-owner',...own,...extra}); }
async function party(name, extra={}){ return post('/api/parties',{name,...own,...extra}); }
async function order(p,q,m,extra={}){ return post('/api/orders',{party:p,quality:q,meters:m,rate_per_m:100,promise_date:'2026-12-31',...own,...extra}); }
async function oget(id, role='owner'){ return get(`/api/orders/${id}?role=${role}`); }
async function freeOf(orderId, lot){ const c=await get(`/api/orders/${orderId}/candidates?role=owner`); const l=(c.body.lots||[]).find(l=>l.lot_id===lot); return l?Number(l.free):null; }
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

// ---------- setup parties ----------
const P1=S+'-P1', P2=S+'-P2', P3=S+'-P3';
const p1=(await party(P1)).body.party, p2=(await party(P2)).body.party, p3=(await party(P3)).body.party;

// ================= R1 STOCK =================
{
  const L=S+'-L1', Q=S+'-Q1';
  let r=await IN(L,Q,1000);
  check('R1.1','IN 1000 m creates lot with balance 1000',{method:'POST',url:'/api/stock',body:{direction:'IN',lot_id:L,grey_meters:1000,finished_meters:1000}},'balance 1000', r.status<300 && await bal(L)===1000, {status:r.status,balance:await bal(L)});
  r=await OUT(L,300);
  check('R1.1','OUT 300 → balance 700',{method:'POST',url:'/api/stock',body:{direction:'OUT',lot_id:L,meters:300}},'balance 700', r.status<300 && await bal(L)===700, {status:r.status,balance:await bal(L)});
  r=await OUT(L,800);
  check('R1.2','OUT 800 > balance 700 refused, balance unchanged',{method:'POST',url:'/api/stock',body:{direction:'OUT',lot_id:L,meters:800}},'4xx, balance 700', is4xx(r.status) && await bal(L)===700, {status:r.status,body:r.body,balance:await bal(L)});
  r=await OUT(L,700.01);
  check('R1.2','OUT 700.01 (just over balance) refused',{method:'POST',url:'/api/stock',body:{direction:'OUT',lot_id:L,meters:700.01}},'4xx, balance 700', is4xx(r.status) && await bal(L)===700, {status:r.status,balance:await bal(L)});
  r=await OUT(L,0.5);
  check('R1.1','OUT 0.5 fractional → balance 699.5',{method:'POST',url:'/api/stock',body:{direction:'OUT',lot_id:L,meters:0.5}},'balance 699.5', r.status<300 && await bal(L)===699.5, {status:r.status,balance:await bal(L)});
  r=await IN(L,Q,300.5);
  check('R1.1','Second IN 300.5 on same lot → balance 1000',{method:'POST',url:'/api/stock',body:{direction:'IN',lot_id:L,grey_meters:300.5,finished_meters:300.5}},'balance 1000', r.status<300 && await bal(L)===1000, {status:r.status,balance:await bal(L)});
  for(const [lbl,m] of [['0',0],['-50',-50],['"abc"','abc'],['null',null],['"1e999"','1e999']]){
    r=await OUT(L,m);
    check('R1.2','OUT meters='+lbl+' refused with 4xx, balance unchanged',{method:'POST',url:'/api/stock',body:{direction:'OUT',lot_id:L,meters:m}},'4xx, balance 1000', is4xx(r.status) && await bal(L)===1000, {status:r.status,body:r.body,balance:await bal(L)});
  }
  for(const [lbl,m] of [['0',0],['-10',-10],['"xyz"','xyz']]){
    const L2=S+'-LBAD'+n;
    r=await IN(L2,Q,m);
    check('R1.2','IN grey/finished meters='+lbl+' refused with 4xx',{method:'POST',url:'/api/stock',body:{direction:'IN',lot_id:L2,grey_meters:m,finished_meters:m}},'4xx, lot not created', is4xx(r.status) && await bal(L2)===null, {status:r.status,body:r.body,balance:await bal(L2)});
  }
  r=await IN(S+'-HUGE',Q,1e300);
  check('Access/bad-input','IN meters=1e300 must not 500',{method:'POST',url:'/api/stock',body:{direction:'IN',lot_id:S+'-HUGE',grey_meters:1e300,finished_meters:1e300}},'not 500 (4xx preferred)', r.status<500, {status:r.status,body:r.body});
  r=await OUT(S+'-NOPE',10);
  check('R1.2','OUT on unknown lot → 4xx',{method:'POST',url:'/api/stock',body:{direction:'OUT',lot_id:S+'-NOPE',meters:10}},'4xx', is4xx(r.status), {status:r.status,body:r.body});
  r=await post('/api/stock',{direction:'IN',quality:Q,design:'D',grey_meters:10,finished_meters:10,mill_name:'M',moved_by:'usr-owner',...own});
  check('Access/bad-input','IN missing lot_id → 4xx',{method:'POST',url:'/api/stock',body:{direction:'IN',quality:Q,grey_meters:10}},'4xx', is4xx(r.status), {status:r.status,body:r.body});
  r=await post('/api/stock',{direction:'SIDEWAYS',lot_id:L,meters:10,...own});
  check('Access/bad-input','Unknown direction → 4xx',{method:'POST',url:'/api/stock',body:{direction:'SIDEWAYS',lot_id:L,meters:10}},'4xx', is4xx(r.status), {status:r.status,body:r.body});
  r=await call('POST','/api/stock','{not json');
  check('Access/bad-input','Malformed JSON body → 4xx',{method:'POST',url:'/api/stock',body:'{not json'},'4xx', is4xx(r.status), {status:r.status,body:r.body});
  const sq=S+"-x'; DROP TABLE stock_movements;--";
  r=await IN(sq,Q,10);
  const st=await get('/api/stock?role=owner');
  check('Access/bad-input','SQL-ish lot_id does not 500 and stock listing still works',{method:'POST',url:'/api/stock',body:{direction:'IN',lot_id:sq}},'not 500; GET /api/stock 200', r.status<500 && st.status===200, {status:r.status,list:st.status});
  r=await OUT(L,10,{role:'worker',actor:'usr-demo-wrk'});
  rec('Access','Worker OUT movement (stock not listed in worker-refused set)',{method:'POST',url:'/api/stock',body:{direction:'OUT',role:'worker'}},'spec silent',{status:r.status},'ambiguous');
  if(r.status<300) await IN(L,Q,10);
}

// ================= R2 PARTIES =================
function gstin(state, pan, ent){
  const cs='0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'; const base=state+pan+ent+'Z';
  let sum=0; for(let i=0;i<14;i++){ const v=cs.indexOf(base[i])*(i%2?2:1); sum+=Math.floor(v/36)+v%36; }
  return base+cs[(36-sum%36)%36];
}
{
  let r=await party('  '+P1.toLowerCase()+'  ');
  check('R2.1','Duplicate party name (lowercase + spaces) refused',{method:'POST',url:'/api/parties',body:{name:'  '+P1.toLowerCase()+'  '}},'4xx', is4xx(r.status), {status:r.status,body:r.body});
  r=await party(P1.toUpperCase());
  check('R2.1','Duplicate party name (uppercase) refused',{method:'POST',url:'/api/parties',body:{name:P1.toUpperCase()}},'4xx', is4xx(r.status), {status:r.status,body:r.body});
  const good=gstin('24','AAACB'+String(1000+Math.floor(Math.random()*8999))+'C','1');
  r=await party(S+'-G1',{gstin:good,state_code:'24'});
  check('R2.2','Valid GSTIN '+good+' accepted',{method:'POST',url:'/api/parties',body:{name:S+'-G1',gstin:good}},'2xx', r.status<300, {status:r.status,body:r.body});
  const badChk=good.slice(0,14)+(good[14]==='A'?'B':'A');
  r=await party(S+'-G2',{gstin:badChk});
  check('R2.2','GSTIN with wrong check char refused',{method:'POST',url:'/api/parties',body:{name:S+'-G2',gstin:badChk}},'4xx', is4xx(r.status), {status:r.status,body:r.body});
  for(const g of ['12345','24AAACB1234C1Z','24AAACB1234C1X'+good[14], 'AAAAACB1234C1Z5', "24'; DROP TABLE parties;--"]){
    r=await party(S+'-G'+n,{gstin:g});
    check('R2.2','Invalid GSTIN "'+g+'" refused',{method:'POST',url:'/api/parties',body:{name:S+'-G?',gstin:g}},'4xx', is4xx(r.status), {status:r.status,body:r.body});
  }
  r=await party(S+'-CD');
  check('R2.3','credit_days defaults to 30',{method:'POST',url:'/api/parties',body:{name:S+'-CD'}},'credit_days 30', r.body?.party?.credit_days===30, r.body);
  r=await party(S+'-CD45',{credit_days:45,credit_limit:50000});
  check('R2.3','credit_days 45 / credit_limit 50000 stored',{method:'POST',url:'/api/parties',body:{name:S+'-CD45',credit_days:45,credit_limit:50000}},'45 / 50000', r.body?.party?.credit_days===45 && Number(r.body?.party?.credit_limit)===50000, r.body);
  r=await party('');
  check('Access/bad-input','Empty party name refused',{method:'POST',url:'/api/parties',body:{name:''}},'4xx', is4xx(r.status), {status:r.status,body:r.body});
  r=await patch('/api/parties/'+p2.id,{name:' '+P1.toLowerCase(),...own});
  check('R2.1','PATCH rename to existing name (case/space variant) refused',{method:'PATCH',url:'/api/parties/'+p2.id,body:{name:' '+P1.toLowerCase()}},'4xx', is4xx(r.status), {status:r.status,body:r.body});
  r=await patch('/api/parties/'+p2.id,{gstin:'99INVALID',...own});
  check('R2.2','PATCH invalid GSTIN refused',{method:'PATCH',url:'/api/parties/'+p2.id,body:{gstin:'99INVALID'}},'4xx', is4xx(r.status), {status:r.status,body:r.body});
  r=await patch('/api/parties/99999999',{phone:'1',...own});
  check('Access/bad-input','PATCH unknown party id → 4xx',{method:'PATCH',url:'/api/parties/99999999'},'4xx', is4xx(r.status), {status:r.status,body:r.body});
  r=await patch('/api/parties/abc',{phone:'1',...own});
  check('Access/bad-input','PATCH non-numeric party id → 4xx',{method:'PATCH',url:'/api/parties/abc'},'4xx', is4xx(r.status), {status:r.status,body:r.body});
  r=await party(S+'-NEG',{credit_days:'abc'});
  check('Access/bad-input','credit_days="abc" must not 500',{method:'POST',url:'/api/parties',body:{credit_days:'abc'}},'not 500', r.status<500, {status:r.status,body:r.body});
  r=await get('/api/parties?role=supervisor');
  const lk=moneyLeaks(r.body);
  check('Access','Supervisor GET /api/parties has no credit limit / money',{method:'GET',url:'/api/parties?role=supervisor'},'no money fields', r.status===403 || lk.length===0, {status:r.status,leaks:lk.slice(0,5)});
}

// ================= R3 RATES =================
{
  const Q=S+'-QR';
  const rate=(b)=>post('/api/rates',{quality:Q,...own,...b});
  await rate({rate_per_m:100,valid_from:'2026-01-01'});
  await rate({rate_per_m:110,valid_from:'2026-06-01'});
  await rate({rate_per_m:999,valid_from:'2099-01-01'});
  await rate({rate_per_m:90,valid_from:'2026-02-01',party_id:p1.id});
  await rate({rate_per_m:95,valid_from:'2099-01-01',party_id:p1.id});
  await rate({rate_per_m:777,valid_from:'2099-01-01',party_id:p3.id});
  const lk=async(qs)=> (await get(`/api/orders/rate?quality=${encodeURIComponent(Q)}&role=owner${qs}`));
  const num=b=> b?.rate && typeof b.rate==='object' ? Number(b.rate.rate_per_m) : (b?.rate==null?null:Number(b.rate));
  let r=await lk('&party='+encodeURIComponent(P2));
  check('R3.2','Rate for party w/o specific rate → latest valid general (110, not future 999)',{method:'GET',url:`/api/orders/rate?quality=${Q}&party=${P2}`},'110', num(r.body)===110, r.body);
  r=await lk('&party_id='+p1.id);
  check('R3.2','Party-specific rate (90, from Feb) beats later general 110; future 95 ignored',{method:'GET',url:`/api/orders/rate?quality=${Q}&party_id=${p1.id}`},'90', num(r.body)===90, r.body);
  r=await lk('&party='+encodeURIComponent(P1));
  check('R3.2','Same lookup by party name',{method:'GET',url:`/api/orders/rate?quality=${Q}&party=${P1}`},'90', num(r.body)===90, r.body);
  r=await lk('&party_id='+p3.id);
  check('R3.2','Party with only future-dated specific rate falls back to general 110',{method:'GET',url:`/api/orders/rate?quality=${Q}&party_id=${p3.id}`},'110', num(r.body)===110, r.body);
  r=await lk('');
  check('R3.2','No party → general 110',{method:'GET',url:`/api/orders/rate?quality=${Q}`},'110', num(r.body)===110, r.body);
  r=await get(`/api/orders/rate?quality=${S}-NORATE&role=owner`);
  check('R3.2','Quality with no rate → no rate',{method:'GET',url:`/api/orders/rate?quality=${S}-NORATE`},'null/absent rate', r.status<500 && (num(r.body)===null || Number.isNaN(num(r.body))), {status:r.status,body:r.body});
  for(const v of [-5,0,'abc']){
    r=await rate({rate_per_m:v,valid_from:'2026-01-01'});
    check('Access/bad-input','rate_per_m='+JSON.stringify(v)+' refused',{method:'POST',url:'/api/rates',body:{quality:Q,rate_per_m:v}},'4xx', is4xx(r.status), {status:r.status,body:r.body});
  }
  r=await rate({rate_per_m:50,valid_from:'not-a-date'});
  check('Access/bad-input','valid_from="not-a-date" refused, not 500',{method:'POST',url:'/api/rates',body:{valid_from:'not-a-date'}},'4xx', is4xx(r.status), {status:r.status,body:r.body});
  r=await rate({rate_per_m:50,party_id:99999999});
  check('Access/bad-input','Rate for unknown party_id → 4xx',{method:'POST',url:'/api/rates',body:{party_id:99999999}},'4xx', is4xx(r.status), {status:r.status,body:r.body});
  r=await post('/api/rates',{quality:Q,rate_per_m:1,...sup});
  check('Access','Supervisor POST /api/rates → 403',{method:'POST',url:'/api/rates',body:{role:'supervisor'}},'403', r.status===403, {status:r.status});
  r=await get('/api/rates?role=supervisor');
  check('Access','Supervisor GET /api/rates → 403',{method:'GET',url:'/api/rates?role=supervisor'},'403', r.status===403, {status:r.status});
  r=await get(`/api/orders/rate?quality=${Q}&role=supervisor`);
  check('Access','Supervisor rate lookup gives no ₹ value',{method:'GET',url:`/api/orders/rate?quality=${Q}&role=supervisor`},'403 or no rate', r.status===403 || moneyLeaks(r.body).length===0, {status:r.status,body:r.body});
  r=await get(`/api/orders/rate?quality=${Q}&role=worker`);
  check('Access','Worker rate lookup refused',{method:'GET',url:`/api/orders/rate?quality=${Q}&role=worker`},'403', r.status===403, {status:r.status,body:r.body});
  r=await get('/api/rates?role=worker');
  check('Access','Worker GET /api/rates → 403',{method:'GET',url:'/api/rates?role=worker'},'403', r.status===403, {status:r.status});
  r=await get('/api/rates');
  check('Access','Missing role GET /api/rates → 403 (treated as worker)',{method:'GET',url:'/api/rates'},'403', r.status===403, {status:r.status});
}

// ================= ACCESS on orders/inquiries/dispatches =================
{
  for(const [m,u,b] of [['GET','/api/orders?role=worker'],['GET','/api/orders'],['GET','/api/orders?role=hacker'],['GET','/api/inquiries?role=worker'],['GET','/api/dispatches?role=worker'],
    ['POST','/api/orders',{party:P1,quality:'X',meters:1,rate_per_m:1,promise_date:'2026-12-01',...wrk}],
    ['POST','/api/inquiries',{raw_text:'need 5 m X',...wrk}],
    ['POST','/api/dispatches',{party:P1,lines:[{lot_id:S+'-L1',meters:1}],...wrk}],
    ['POST','/api/dispatches',{party:P1,lines:[{lot_id:S+'-L1',meters:1}]}],
    ['GET','/api/invoices?role=supervisor'],['GET','/api/payments?role=supervisor'],['GET','/api/costs?role=supervisor'],['GET','/api/margin?role=supervisor'],['GET','/api/credit?role=supervisor'],['GET','/api/settings/billing?role=supervisor']]){
    const r=await call(m,u,b);
    check('Access',`${m} ${u} ${b?('role='+(b.role||'none')):''} refused`,{method:m,url:u,body:b},'403', r.status===403, {status:r.status});
  }
}

// ================= R6 ALLOCATION =================
let orderForSugg=null;
{
  const Q=S+'-QA';
  const A1=S+'-A1', A2=S+'-A2';
  await IN(A1,Q,500); await sleep(30); await IN(A2,Q,500);
  const o=(await order(P1,Q,300)).body.order;
  let r=await post(`/api/orders/${o.id}/allocate`,{auto:true,...own});
  let og=await oget(o.id);
  const al=og.body.allocations||[];
  const tot=al.reduce((s,a)=>s+Number(a.meters),0);
  check('R6.3','Auto-allocate 300 m with two 500 m lots → oldest lot A1 only, total 300',{method:'POST',url:`/api/orders/${o.id}/allocate`,body:{auto:true}},'one allocation on '+A1+' of 300', al.length===1 && al[0].lot_id===A1 && tot===300, {status:r.status,alloc:al.map(a=>[a.lot_id,a.meters])});
  let f=await freeOf(o.id,A1);
  check('R1.3','Free of A1 = 500 − 300 reserved = 200',{method:'GET',url:`/api/orders/${o.id}/candidates`},'200', f===200, {free:f});
  r=await post(`/api/orders/${o.id}/allocate`,{auto:true,...own});
  og=await oget(o.id);
  const tot2=(og.body.allocations||[]).filter(a=>a.status!=='released').reduce((s,a)=>s+Number(a.meters),0);
  check('R6.3','Second auto-allocate on fully allocated order reserves nothing more',{method:'POST',url:`/api/orders/${o.id}/allocate`,body:{auto:true}},'total reserved stays 300', tot2===300, {status:r.status,total:tot2});
  // release
  const aid=al[0]?.id;
  r=await post(`/api/allocations/${aid}/release`,{...own});
  f=await freeOf(o.id,A1);
  check('R6.4','Release allocation → A1 free back to 500',{method:'POST',url:`/api/allocations/${aid}/release`},'free 500', f===500, {status:r.status,free:f});
  r=await post(`/api/allocations/${aid}/release`,{...own});
  f=await freeOf(o.id,A1);
  check('R6.4','Releasing same allocation twice does not inflate free (≤ balance)',{method:'POST',url:`/api/allocations/${aid}/release`},'free stays 500', f===500 && r.status<500, {status:r.status,free:f});
  r=await post(`/api/allocations/99999999/release`,{...own});
  check('Access/bad-input','Release unknown allocation → 4xx',{method:'POST',url:'/api/allocations/99999999/release'},'4xx', is4xx(r.status), {status:r.status,body:r.body});
  // manual
  r=await post(`/api/orders/${o.id}/allocate`,{lot_id:A2,meters:100,...own});
  f=await freeOf(o.id,A2);
  check('R6.1/R1.3','Manual allocate 100 from A2 → A2 free 400',{method:'POST',url:`/api/orders/${o.id}/allocate`,body:{lot_id:A2,meters:100}},'free 400', r.status<300 && f===400, {status:r.status,free:f});
  // different quality
  const L1=S+'-L1';
  r=await post(`/api/orders/${o.id}/allocate`,{lot_id:L1,meters:10,...own});
  check('R6.1','Allocate lot of different quality refused',{method:'POST',url:`/api/orders/${o.id}/allocate`,body:{lot_id:L1,meters:10}},'4xx', is4xx(r.status), {status:r.status,body:r.body});
  for(const v of [0,-20,'abc',null]){
    r=await post(`/api/orders/${o.id}/allocate`,{lot_id:A2,meters:v,...own});
    check('Access/bad-input','Allocate meters='+JSON.stringify(v)+' refused',{method:'POST',url:`/api/orders/${o.id}/allocate`,body:{lot_id:A2,meters:v}},'4xx', is4xx(r.status), {status:r.status,body:r.body});
  }
  r=await post(`/api/orders/${o.id}/allocate`,{lot_id:S+'-NOLOT',meters:5,...own});
  check('Access/bad-input','Allocate unknown lot → 4xx',{method:'POST',url:`/api/orders/${o.id}/allocate`,body:{lot_id:'unknown'}},'4xx', is4xx(r.status), {status:r.status});
  r=await post(`/api/orders/99999999/allocate`,{auto:true,...own});
  check('Access/bad-input','Allocate on unknown order → 4xx',{method:'POST',url:'/api/orders/99999999/allocate'},'4xx', is4xx(r.status), {status:r.status});
  r=await post(`/api/orders/abc/allocate`,{auto:true,...own});
  check('Access/bad-input','Allocate on non-numeric order id → 4xx',{method:'POST',url:'/api/orders/abc/allocate'},'4xx', is4xx(r.status), {status:r.status});
  // over-allocation across orders (sequential)
  const o2=(await order(P2,Q,1000)).body.order;
  r=await post(`/api/orders/${o2.id}/allocate`,{lot_id:A2,meters:450,...own});
  const f2=await freeOf(o2.id,A2);
  check('R6.2','Allocate 450 from A2 when only 400 free (other order holds 100) → refused or capped; reserved ≤ balance',{method:'POST',url:`/api/orders/${o2.id}/allocate`,body:{lot_id:A2,meters:450}},'4xx (or capped) and free ≥ 0', f2!==null && f2>=0 && (is4xx(r.status) || f2===0), {status:r.status,body:r.body,free:f2});
  // supervisor / worker
  r=await post(`/api/orders/${o.id}/allocate`,{lot_id:A2,meters:1,role:'worker',actor:'usr-demo-wrk'});
  check('Access','Worker allocate → 403',{method:'POST',url:`/api/orders/${o.id}/allocate`,body:{role:'worker'}},'403', r.status===403, {status:r.status});
  r=await post(`/api/orders/${o.id}/allocate`,{auto:true,...sup});
  const lks=moneyLeaks(r.body);
  check('Access','Supervisor allocate allowed and response has no money',{method:'POST',url:`/api/orders/${o.id}/allocate`,body:{auto:true,role:'supervisor'}},'2xx, no ₹ fields', r.status<300 && lks.length===0, {status:r.status,leaks:lks});
  // cancel releases
  const Q5=S+'-QC', C1=S+'-C1'; await IN(C1,Q5,400);
  const oc=(await order(P1,Q5,250)).body.order;
  await post(`/api/orders/${oc.id}/allocate`,{auto:true,...own});
  const before=await freeOf(oc.id,C1);
  r=await patch(`/api/orders/${oc.id}`,{status:'cancelled',...own});
  const oc2=(await order(P2,Q5,10)).body.order;
  const after=await freeOf(oc2.id,C1);
  const st=(await oget(oc.id)).body.order?.status;
  check('R6.5/R5.1','Cancel order → status cancelled, reservation released (free 150 → 400)',{method:'PATCH',url:`/api/orders/${oc.id}`,body:{status:'cancelled'}},'status cancelled; free 150→400', before===150 && after===400 && st==='cancelled', {status:r.status,before,after,orderStatus:st});
  // concurrency: 5 orders × 300 on one 1000 m lot
  const Q6=S+'-QX', X1=S+'-X1'; await IN(X1,Q6,1000);
  const os=[]; for(let i=0;i<5;i++) os.push((await order(P1,Q6,300)).body.order);
  const res=await Promise.all(os.map(o=>post(`/api/orders/${o.id}/allocate`,{lot_id:X1,meters:300,...own})));
  const ok=res.filter(x=>x.status<300).length, five=res.filter(x=>x.status>=500).length;
  let reserved=0; for(const o of os){ const g=await oget(o.id); reserved+=(g.body.allocations||[]).filter(a=>a.status==='reserved').reduce((s,a)=>s+Number(a.meters),0); }
  check('R6.2','5 parallel manual allocations of 300 on a 1000 m lot → total reserved ≤ 1000',{method:'POST ×5 parallel',url:'/api/orders/<id>/allocate',body:{lot_id:X1,meters:300}},'reserved ≤ 1000 (≤3 succeed), no 500', reserved<=1000 && five===0, {statuses:res.map(x=>x.status),reserved});
  const fx=await freeOf(os[0].id,X1);
  check('R1.3','Free after concurrent allocations = 1000 − reserved, never negative',{method:'GET',url:`/api/orders/${os[0].id}/candidates`},`free = ${1000-reserved}, ≥0`, fx===1000-reserved && fx>=0, {free:fx,reserved});
  // concurrency: auto
  const Q7=S+'-QY', Y1=S+'-Y1'; await IN(Y1,Q7,1000);
  const oy=[]; for(let i=0;i<5;i++) oy.push((await order(P2,Q7,400)).body.order);
  const ry=await Promise.all(oy.map(o=>post(`/api/orders/${o.id}/allocate`,{auto:true,...own})));
  let ry_res=0; for(const o of oy){ const g=await oget(o.id); ry_res+=(g.body.allocations||[]).filter(a=>a.status==='reserved').reduce((s,a)=>s+Number(a.meters),0); }
  check('R6.2','5 parallel AUTO allocations (400 each) on a 1000 m lot → total reserved ≤ 1000',{method:'POST ×5 parallel',url:'/api/orders/<id>/allocate',body:{auto:true}},'reserved ≤ 1000, no 500', ry_res<=1000 && ry.every(x=>x.status<500), {statuses:ry.map(x=>x.status),reserved:ry_res});
  // same order, parallel manual beyond need? Just over balance
  const Q8=S+'-QZ', Z1=S+'-Z1'; await IN(Z1,Q8,100);
  const oz=(await order(P1,Q8,1000)).body.order;
  const rz=await Promise.all([1,2,3,4,5].map(()=>post(`/api/orders/${oz.id}/allocate`,{lot_id:Z1,meters:40,...own})));
  const gz=await oget(oz.id); const rzr=(gz.body.allocations||[]).filter(a=>a.status==='reserved').reduce((s,a)=>s+Number(a.meters),0);
  check('R6.2','5 parallel allocations of 40 m by the same order on a 100 m lot → reserved ≤ 100',{method:'POST ×5 parallel',url:`/api/orders/${oz.id}/allocate`,body:{lot_id:Z1,meters:40}},'reserved ≤ 100', rzr<=100, {statuses:rz.map(x=>x.status),reserved:rzr});
  // fewest vs oldest ambiguous
  const Q9=S+'-QF'; await IN(S+'-F1',Q9,100); await sleep(20); await IN(S+'-F2',Q9,100); await sleep(20); await IN(S+'-F3',Q9,1000);
  const of=(await order(P1,Q9,500)).body.order;
  await post(`/api/orders/${of.id}/allocate`,{auto:true,...own});
  const gf=await oget(of.id); const af=(gf.body.allocations||[]).map(a=>[a.lot_id,Number(a.meters)]);
  const tf=af.reduce((s,a)=>s+a[1],0);
  check('R6.3','Auto-alloc never reserves more than order needs (500)',{method:'POST',url:`/api/orders/${of.id}/allocate`,body:{auto:true}},'total ≤ 500 and =500 (stock suffices)', tf===500, af);
  rec('R6.3','Oldest (100+100+300 over 3 lots) vs fewest (500 from newest lot) conflict — precedence unspecified',{method:'POST',url:`/api/orders/${of.id}/allocate`,body:{auto:true}},'unspecified',af,'ambiguous');
  // manual over order need
  const Q10=S+'-QM'; await IN(S+'-M1',Q10,1000);
  const om=(await order(P1,Q10,100)).body.order;
  r=await post(`/api/orders/${om.id}/allocate`,{lot_id:S+'-M1',meters:500,...own});
  rec('R6.3','Manual allocation of 500 on 100 m order (R6.3 only covers auto)',{method:'POST',url:`/api/orders/${om.id}/allocate`,body:{lot_id:S+'-M1',meters:500}},'unspecified',{status:r.status,body:r.body},'ambiguous');
  orderForSugg={Q:Q10};
}

// ================= R5 ORDERS input =================
{
  const Q=S+'-QO';
  for(const [lbl,b] of [['meters 0',{meters:0}],['meters -5',{meters:-5}],['meters "abc"',{meters:'abc'}],['meters missing',{meters:undefined}],['huge meters 1e400 string',{meters:'1e400'}]]){
    const r=await post('/api/orders',{party:P1,quality:Q,rate_per_m:100,promise_date:'2026-12-01',...own,...b});
    check('R5.1',`Create order with ${lbl} refused`,{method:'POST',url:'/api/orders',body:b},'4xx', is4xx(r.status), {status:r.status,body:r.body});
  }
  let r=await post('/api/orders',{quality:Q,meters:10,rate_per_m:100,promise_date:'2026-12-01',...own});
  check('R5.1','Create order without party refused',{method:'POST',url:'/api/orders',body:{quality:Q,meters:10}},'4xx', is4xx(r.status), {status:r.status,body:r.body});
  r=await post('/api/orders',{party_id:99999999,quality:Q,meters:10,rate_per_m:100,promise_date:'2026-12-01',...own});
  check('R5.1','Create order for unknown party_id refused',{method:'POST',url:'/api/orders',body:{party_id:99999999}},'4xx', is4xx(r.status), {status:r.status,body:r.body});
  r=await post('/api/orders',{party:P1,meters:10,rate_per_m:100,promise_date:'2026-12-01',...own});
  check('R5.1','Create order without quality refused',{method:'POST',url:'/api/orders',body:{party:P1,meters:10}},'4xx', is4xx(r.status), {status:r.status,body:r.body});
  r=await post('/api/orders',{party:P1,quality:Q,meters:10,rate_per_m:100,promise_date:'31/31/2026',...own});
  check('Access/bad-input','Create order with invalid promise_date not 500',{method:'POST',url:'/api/orders',body:{promise_date:'31/31/2026'}},'4xx', is4xx(r.status), {status:r.status,body:r.body});
  r=await post('/api/orders',{party:P1,quality:Q,meters:10,rate_per_m:-3,promise_date:'2026-12-01',...own});
  check('Access/bad-input','Create order with negative rate refused',{method:'POST',url:'/api/orders',body:{rate_per_m:-3}},'4xx', is4xx(r.status), {status:r.status,body:r.body});
  r=await get('/api/orders/99999999?role=owner');
  check('Access/bad-input','GET unknown order → 404',{method:'GET',url:'/api/orders/99999999'},'4xx', is4xx(r.status), {status:r.status});
  r=await get("/api/orders/1%27%20OR%201=1--?role=owner");
  check('Access/bad-input','GET order with SQL-ish id → 4xx',{method:'GET',url:"/api/orders/1' OR 1=1--"},'4xx', is4xx(r.status), {status:r.status});
  const o=(await order(P1,Q,10)).body.order;
  r=await patch(`/api/orders/${o.id}`,{meters:-10,...own});
  check('R5.1','PATCH order meters -10 refused',{method:'PATCH',url:`/api/orders/${o.id}`,body:{meters:-10}},'4xx', is4xx(r.status), {status:r.status,body:r.body});
  r=await patch(`/api/orders/${o.id}`,{status:'banana',...own});
  check('R5.1','PATCH order status "banana" refused',{method:'PATCH',url:`/api/orders/${o.id}`,body:{status:'banana'}},'4xx', is4xx(r.status), {status:r.status,body:r.body});
  r=await get('/api/orders?role=supervisor');
  let lk=moneyLeaks(r.body);
  check('Access','Supervisor GET /api/orders: 200 with no rate/money',{method:'GET',url:'/api/orders?role=supervisor'},'200, no ₹ fields', r.status===200 && lk.length===0, {status:r.status,leaks:lk.slice(0,5)});
  r=await get(`/api/orders/${o.id}?role=supervisor`);
  lk=moneyLeaks(r.body);
  check('Access','Supervisor GET /api/orders/<id>: no rate/money',{method:'GET',url:`/api/orders/${o.id}?role=supervisor`},'200, no ₹ fields', r.status===200 && lk.length===0, {status:r.status,leaks:lk.slice(0,5)});
  r=await post('/api/orders',{party:P1,quality:Q,meters:10,rate_per_m:123,promise_date:'2026-12-01',...sup});
  lk=moneyLeaks(r.body);
  check('Access','Supervisor POST /api/orders response has no rate',{method:'POST',url:'/api/orders',body:{role:'supervisor',rate_per_m:123}},'no ₹ fields in response', lk.length===0, {status:r.status,leaks:lk});
  r=await patch(`/api/orders/${o.id}`,{promise_date:'2026-12-15',...sup});
  lk=moneyLeaks(r.body);
  check('Access','Supervisor PATCH order response has no rate',{method:'PATCH',url:`/api/orders/${o.id}`,body:{role:'supervisor'}},'no ₹ fields', lk.length===0, {status:r.status,leaks:lk});
  r=await get(`/api/orders/${o.id}/candidates?role=worker`);
  check('Access','Worker GET candidates → 403',{method:'GET',url:`/api/orders/${o.id}/candidates?role=worker`},'403', r.status===403, {status:r.status});
}

// ================= R7 DISPATCH =================
{
  const Q=S+'-QD', D1=S+'-D1', D2=S+'-D2';
  await IN(D1,Q,500); await IN(D2,Q,200);
  const dcount=async()=> ((await get('/api/dispatches?role=owner')).body.dispatches||[]).length;
  let c0=await dcount();
  let r=await post('/api/dispatches',{party:P1,lines:[{lot_id:D1,meters:100},{lot_id:D2,meters:50}],transporter:'BBA Roadways',lr_no:'LR-77',vehicle_no:'GJ05AB1234',packages:7,...own});
  const b1=await bal(D1), b2=await bal(D2);
  check('R7.1','Two-line dispatch drops balances by exactly 100 and 50',{method:'POST',url:'/api/dispatches',body:{party:P1,lines:[{lot_id:D1,meters:100},{lot_id:D2,meters:50}]}},'D1 400, D2 150', r.status<300 && b1===400 && b2===150, {status:r.status,b1,b2});
  const did=r.body?.dispatch?.id;
  const dg=await get(`/api/dispatches/${did}?role=owner`);
  const dd=dg.body?.dispatch||dg.body;
  check('R7.1','Transport details stored (transporter, LR, vehicle, packages)',{method:'GET',url:`/api/dispatches/${did}`},'BBA Roadways / LR-77 / GJ05AB1234 / 7', dd?.transporter==='BBA Roadways' && dd?.lr_no==='LR-77' && dd?.vehicle_no==='GJ05AB1234' && Number(dd?.packages)===7, {transporter:dd?.transporter,lr:dd?.lr_no,veh:dd?.vehicle_no,pk:dd?.packages});
  c0=await dcount();
  r=await post('/api/dispatches',{party:P1,lines:[{lot_id:D1,meters:100},{lot_id:D2,meters:151}],...own});
  check('R7.2','Line 2 exceeds balance → refused, line 1 not recorded (all-or-nothing)',{method:'POST',url:'/api/dispatches',body:{lines:[{lot_id:D1,meters:100},{lot_id:D2,meters:151}]}},'4xx; D1 400, D2 150; dispatch count unchanged', is4xx(r.status) && await bal(D1)===400 && await bal(D2)===150 && await dcount()===c0, {status:r.status,body:r.body,b1:await bal(D1),b2:await bal(D2)});
  r=await post('/api/dispatches',{party:P1,lines:[{lot_id:D2,meters:100},{lot_id:D2,meters:100}],...own});
  check('R7.2','Same lot twice (100+100 > 150) refused, nothing recorded',{method:'POST',url:'/api/dispatches',body:{lines:[{lot_id:D2,meters:100},{lot_id:D2,meters:100}]}},'4xx; D2 stays 150', is4xx(r.status) && await bal(D2)===150, {status:r.status,body:r.body,b2:await bal(D2)});
  r=await post('/api/dispatches',{party:P1,lines:[{lot_id:D1,meters:10},{lot_id:S+'-NOLOT',meters:5}],...own});
  check('R7.2','Line with unknown lot → refused, first line not recorded',{method:'POST',url:'/api/dispatches',body:{lines:[{lot_id:D1,meters:10},{lot_id:'unknown',meters:5}]}},'4xx; D1 stays 400', is4xx(r.status) && await bal(D1)===400, {status:r.status,b1:await bal(D1)});
  for(const v of [0,-10,'abc',null]){
    r=await post('/api/dispatches',{party:P1,lines:[{lot_id:D1,meters:v}],...own});
    check('R1.2','Dispatch line meters='+JSON.stringify(v)+' refused, balance unchanged',{method:'POST',url:'/api/dispatches',body:{lines:[{lot_id:D1,meters:v}]}},'4xx; D1 400', is4xx(r.status) && await bal(D1)===400, {status:r.status,body:r.body,b1:await bal(D1)});
  }
  r=await post('/api/dispatches',{party:P1,lines:[{lot_id:D1,meters:10},{lot_id:D2,meters:-10}],...own});
  check('R7.2','Mixed valid + negative line refused, nothing recorded',{method:'POST',url:'/api/dispatches',body:{lines:[{lot_id:D1,meters:10},{lot_id:D2,meters:-10}]}},'4xx; D1 400, D2 150', is4xx(r.status) && await bal(D1)===400 && await bal(D2)===150, {status:r.status,b1:await bal(D1),b2:await bal(D2)});
  r=await post('/api/dispatches',{party:P1,lines:[],...own});
  check('Access/bad-input','Dispatch with empty lines refused',{method:'POST',url:'/api/dispatches',body:{lines:[]}},'4xx', is4xx(r.status), {status:r.status,body:r.body});
  r=await post('/api/dispatches',{party:P1,lines:'nope',...own});
  check('Access/bad-input','Dispatch with lines="nope" refused (no 500)',{method:'POST',url:'/api/dispatches',body:{lines:'nope'}},'4xx', is4xx(r.status), {status:r.status,body:r.body});
  r=await post('/api/dispatches',{lines:[{lot_id:D1,meters:1}],...own});
  check('Access/bad-input','Dispatch without party refused',{method:'POST',url:'/api/dispatches',body:{lines:[{lot_id:D1,meters:1}]}},'4xx', is4xx(r.status) && await bal(D1)===400, {status:r.status,body:r.body});
  r=await post('/api/dispatches',{party:P1,order_id:99999999,lines:[{lot_id:D1,meters:1}],...own});
  check('Access/bad-input','Dispatch against unknown order_id refused, nothing recorded',{method:'POST',url:'/api/dispatches',body:{order_id:99999999}},'4xx; D1 400', is4xx(r.status) && await bal(D1)===400, {status:r.status,body:r.body,b1:await bal(D1)});
  r=await get('/api/dispatches/99999999?role=owner');
  check('Access/bad-input','GET unknown dispatch → 4xx',{method:'GET',url:'/api/dispatches/99999999'},'4xx', is4xx(r.status), {status:r.status});
  r=await post('/api/dispatches',{party:S+'-GHOST-PARTY',lines:[{lot_id:D1,meters:1}],...own});
  rec('R7.1','Dispatch to a party name that does not exist',{method:'POST',url:'/api/dispatches',body:{party:S+'-GHOST-PARTY'}},'unspecified (4xx or auto-create)',{status:r.status,body:r.body?.error||'ok'},'ambiguous');
  if(r.status<300) await IN(D1,Q,1);

  // order status + reservation consumption
  const Q2=S+'-QS', E1=S+'-E1'; await IN(E1,Q2,500);
  const o=(await order(P1,Q2,300)).body.order;
  await post(`/api/orders/${o.id}/allocate`,{lot_id:E1,meters:300,...own});
  r=await post('/api/dispatches',{party:P1,order_id:o.id,lines:[{lot_id:E1,meters:100}],...own});
  let og=await oget(o.id); let resv=(og.body.allocations||[]).filter(a=>a.status==='reserved').reduce((s,a)=>s+Number(a.meters)-Number(a.dispatched_m||0),0);
  let fr=await freeOf(o.id,E1);
  check('R5.2/R7.3','Dispatch 100 of 300 → order partly_dispatched',{method:'POST',url:'/api/dispatches',body:{order_id:o.id,lines:[{lot_id:E1,meters:100}]}},'partly_dispatched', og.body.order?.status==='partly_dispatched', {status:r.status,orderStatus:og.body.order?.status});
  check('R7.3/R1.3','Reservation consumed: balance 400, remaining reserved 200 → free 200',{method:'GET',url:`/api/orders/${o.id}/candidates`},'free 200', fr===200 && await bal(E1)===400, {free:fr,balance:await bal(E1),order_reserved_m:og.body.order?.reserved_m});
  r=await post('/api/dispatches',{party:P1,order_id:o.id,lines:[{lot_id:E1,meters:200}],...own});
  og=await oget(o.id); fr=await freeOf(o.id,E1);
  check('R5.2','Dispatch remaining 200 → order dispatched',{method:'POST',url:'/api/dispatches',body:{order_id:o.id,lines:[{lot_id:E1,meters:200}]}},'dispatched', og.body.order?.status==='dispatched', {status:r.status,orderStatus:og.body.order?.status});
  // free after complete: balance 200, reserved 0 → 200. candidates may not list for a dispatched order; use new order
  const oN=(await order(P2,Q2,1)).body.order; fr=await freeOf(oN.id,E1);
  check('R7.3/R1.3','After full dispatch, no reservation remains: free = balance 200',{method:'GET',url:`/api/orders/${oN.id}/candidates`},'free 200', fr===200, {free:fr,balance:await bal(E1)});
  // over-dispatch order
  const o3=(await order(P1,Q2,50)).body.order;
  r=await post('/api/dispatches',{party:P1,order_id:o3.id,lines:[{lot_id:E1,meters:60}],...own});
  og=await oget(o3.id);
  check('R5.2','Dispatch 60 against 50 m order (no allocation) → dispatched',{method:'POST',url:'/api/dispatches',body:{order_id:o3.id,lines:[{lot_id:E1,meters:60}]}},'dispatched', og.body.order?.status==='dispatched', {status:r.status,orderStatus:og.body.order?.status});
  // Two dispatch lines vs order: partly then dispatched via two lots
  // concurrency dispatch
  const Q3=S+'-QK', K1=S+'-K1'; await IN(K1,Q3,100);
  const rk=await Promise.all([1,2,3,4,5].map(()=>post('/api/dispatches',{party:P1,lines:[{lot_id:K1,meters:30}],...own})));
  const okk=rk.filter(x=>x.status<300).length; const bk=await bal(K1);
  check('R7.2/R1.2','5 parallel dispatches of 30 m on 100 m lot → ≤3 succeed, balance = 100 − 30×successes ≥ 0',{method:'POST ×5 parallel',url:'/api/dispatches',body:{lines:[{lot_id:K1,meters:30}]}},'balance ≥ 0 and consistent, no 500', bk>=0 && bk===100-30*okk && okk<=3 && rk.every(x=>x.status<500), {statuses:rk.map(x=>x.status),balance:bk});
  const K2=S+'-K2'; await IN(K2,Q3,100);
  const rk2=await Promise.all([1,2,3,4,5].map(()=>OUT(K2,30)));
  const ok2=rk2.filter(x=>x.status<300).length; const bk2=await bal(K2);
  check('R1.2','5 parallel stock OUTs of 30 m on 100 m lot → balance never negative',{method:'POST ×5 parallel',url:'/api/stock',body:{direction:'OUT',lot_id:K2,meters:30}},'balance ≥ 0 and =100−30×successes', bk2>=0 && bk2===100-30*ok2, {statuses:rk2.map(x=>x.status),balance:bk2});
  // supervisor dispatch
  const Q4=S+'-QV', V1=S+'-V1'; await IN(V1,Q4,100);
  r=await post('/api/dispatches',{party:P1,lines:[{lot_id:V1,meters:10}],...sup});
  let lk=moneyLeaks(r.body);
  check('Access','Supervisor can dispatch; response has no money',{method:'POST',url:'/api/dispatches',body:{role:'supervisor'}},'2xx, no ₹', r.status<300 && lk.length===0, {status:r.status,leaks:lk});
  r=await get('/api/dispatches?role=supervisor'); lk=moneyLeaks(r.body);
  check('Access','Supervisor GET /api/dispatches: no money',{method:'GET',url:'/api/dispatches?role=supervisor'},'200, no ₹', r.status===200 && lk.length===0, {status:r.status,leaks:lk.slice(0,5)});
  r=await post('/api/dispatches',{party:P1,lines:[{lot_id:V1,meters:10}],create_invoice:true,...sup});
  check('Access','Supervisor dispatch with create_invoice:true must not create an invoice / return money',{method:'POST',url:'/api/dispatches',body:{create_invoice:true,role:'supervisor'}},'403, or no invoice created and no ₹', r.status===403 || (!r.body?.dispatch?.invoice_id && moneyLeaks(r.body).length===0), {status:r.status,invoice_id:r.body?.dispatch?.invoice_id,leaks:moneyLeaks(r.body)});
  // reserved stock of another order dispatched freely
  const Q5=S+'-QW', W1=S+'-W1'; await IN(W1,Q5,100);
  const ow=(await order(P1,Q5,100)).body.order; await post(`/api/orders/${ow.id}/allocate`,{lot_id:W1,meters:100,...own});
  r=await post('/api/dispatches',{party:P2,lines:[{lot_id:W1,meters:50}],...own});
  const resOf=async(id,lot)=>{const g=await oget(id); return (g.body.allocations||[]).filter(a=>a.status==='reserved'&&a.lot_id===lot).reduce((s,a)=>s+Number(a.meters)-Number(a.dispatched_m||0),0);};
  const fw=(await bal(W1))-(await resOf(ow.id,W1));
  rec('R6.2/R7.2','Dispatch 50 m (no order) from a lot fully reserved for another order',{method:'POST',url:'/api/dispatches',body:{party:P2,lines:[{lot_id:W1,meters:50}]}},'unspecified; but R6.2 requires reserved ≤ balance afterwards',{status:r.status,free:fw,balance:await bal(W1)},'ambiguous');
  if(r.status<300){
    check('R6.2','After a non-order dispatch from a fully reserved lot, reserved must still be ≤ balance (free ≥ 0)',{method:'GET',url:`/api/orders/${ow.id}/candidates`},'balance − outstanding reservation ≥ 0', fw>=0, {balance_minus_reserved:fw,balance:await bal(W1),reserved:await resOf(ow.id,W1)});
  }
  // OUT via stock from a reserved lot
  const W2=S+'-W2'; await IN(W2,Q5,100);
  const ow2=(await order(P1,Q5,100)).body.order; await post(`/api/orders/${ow2.id}/allocate`,{lot_id:W2,meters:100,...own});
  r=await OUT(W2,60);
  const fw2=(await bal(W2))-(await resOf(ow2.id,W2));
  const st2=(await oget(ow2.id)).body.order?.status;
  rec('R7.3','Plain stock OUT (no order_id, party = order party) on reserved lot — does it touch the order?',{method:'POST',url:'/api/stock',body:{direction:'OUT',lot_id:W2,meters:60,party:P1}},'unspecified (not a dispatch against the order)',{orderStatus:st2,order_reserved_m:(await oget(ow2.id)).body.order?.reserved_m},'ambiguous');
  if(r.status<300) check('R6.2','After stock OUT 60 on a lot with 100 reserved, reserved must be ≤ balance (free ≥ 0)',{method:'POST',url:'/api/stock',body:{direction:'OUT',lot_id:W2,meters:60}},'refused, or balance − reserved ≥ 0', fw2>=0, {status:r.status,balance_minus_reserved:fw2,balance:await bal(W2)});
  else rec('R6.2','Stock OUT on fully reserved lot refused',{method:'POST',url:'/api/stock'},'unspecified',{status:r.status},'ambiguous');
}

// ================= R4 INQUIRIES =================
{
  const Q=S+'-DON2', I1=S+'-I1';
  await IN(I1,Q,1500);
  await post('/api/rates',{quality:Q,rate_per_m:88,valid_from:'2026-01-01',...own});
  let r=await post('/api/inquiries',{raw_text:`need 2000 m ${Q} by 10th, rate?`,party_name:P1,source:'whatsapp',...own});
  const inq=r.body?.inquiry;
  check('R4.1','English text: extracts quality, meters 2000, needed_by the 10th',{method:'POST',url:'/api/inquiries',body:{raw_text:`need 2000 m ${Q} by 10th, rate?`}},`quality ${Q}, meters 2000, needed_by YYYY-MM-10`, inq?.quality===Q && Number(inq?.meters)===2000 && /-10$/.test(inq?.needed_by||''), {quality:inq?.quality,meters:inq?.meters,needed_by:inq?.needed_by});
  check('R4.2','Owner draft states available 1500 m and includes rate 88',{method:'POST',url:'/api/inquiries'},'reply mentions 1500 and 88', /1,?500/.test(inq?.reply_draft||'') && /88/.test(inq?.reply_draft||''), {reply:inq?.reply_draft});
  r=await get(`/api/inquiries/${inq.id}?role=supervisor`);
  let lk=moneyLeaks(r.body);
  check('R4.2','Supervisor view of inquiry has no rate',{method:'GET',url:`/api/inquiries/${inq.id}?role=supervisor`},'no 88 / no rate fields', r.status===200 && lk.length===0 && !/\b88\b/.test(JSON.stringify(r.body)), {status:r.status,leaks:lk,reply:r.body?.inquiry?.reply_draft});
  r=await get(`/api/inquiries?role=supervisor`);
  lk=moneyLeaks(r.body);
  check('R4.2','Supervisor inquiry list has no rates',{method:'GET',url:'/api/inquiries?role=supervisor'},'no rate fields', r.status===200 && lk.length===0, {status:r.status,leaks:lk.slice(0,5)});
  r=await post('/api/inquiries',{raw_text:`need 300 m ${Q} by 12th`,party_name:P2,...sup});
  lk=moneyLeaks(r.body);
  check('R4.2','Supervisor-created inquiry response & draft contain no rate',{method:'POST',url:'/api/inquiries',body:{role:'supervisor'}},'no rate', r.status<300 && lk.length===0 && !/\b88\b/.test(r.body?.inquiry?.reply_draft||''), {status:r.status,leaks:lk,reply:r.body?.inquiry?.reply_draft});
  r=await post('/api/inquiries',{raw_text:`मुझे 500 मीटर ${Q} चाहिए`,party_name:P1,...own});
  check('R4.1','Hindi text: meters 500 and quality extracted',{method:'POST',url:'/api/inquiries',body:{raw_text:`मुझे 500 मीटर ${Q} चाहिए`}},'meters 500, quality '+Q, Number(r.body?.inquiry?.meters)===500 && r.body?.inquiry?.quality===Q, {status:r.status,meters:r.body?.inquiry?.meters,quality:r.body?.inquiry?.quality});
  r=await post('/api/inquiries',{raw_text:`${Q} 700 મીટર જોઈએ`,party_name:P1,...own});
  check('R4.1','Gujarati text: meters 700 and quality extracted',{method:'POST',url:'/api/inquiries',body:{raw_text:`${Q} 700 મીટર જોઈએ`}},'meters 700, quality '+Q, Number(r.body?.inquiry?.meters)===700 && r.body?.inquiry?.quality===Q, {status:r.status,meters:r.body?.inquiry?.meters,quality:r.body?.inquiry?.quality});
  r=await post('/api/inquiries',{raw_text:'',...own});
  check('Access/bad-input','Empty raw_text refused',{method:'POST',url:'/api/inquiries',body:{raw_text:''}},'4xx', is4xx(r.status), {status:r.status,body:r.body});
  r=await post('/api/inquiries',{raw_text:"'; DELETE FROM inquiries; -- 5 m",...own});
  check('Access/bad-input','SQL-ish raw_text stored without 500',{method:'POST',url:'/api/inquiries',body:{raw_text:"'; DELETE FROM inquiries; --"}},'not 500', r.status<500, {status:r.status});
  r=await get('/api/inquiries/99999999?role=owner');
  check('Access/bad-input','GET unknown inquiry → 4xx',{method:'GET',url:'/api/inquiries/99999999'},'4xx', is4xx(r.status), {status:r.status});
  r=await patch(`/api/inquiries/${inq.id}`,{status:'banana',...own});
  check('R4.3','PATCH inquiry status "banana" refused',{method:'PATCH',url:`/api/inquiries/${inq.id}`,body:{status:'banana'}},'4xx', is4xx(r.status), {status:r.status,body:r.body});
  r=await post(`/api/inquiries/${inq.id}/convert`,{...own});
  rec('R4.3','Convert an inquiry still in status "new"',{method:'POST',url:`/api/inquiries/${inq.id}/convert`},'unspecified',{status:r.status,body:r.body?.error||r.body?.order?.id},'ambiguous');
  // use a fresh inquiry for lifecycle
  r=await post('/api/inquiries',{raw_text:`need 400 m ${Q} by 20th`,party_name:P3,...own});
  const i2=r.body.inquiry;
  r=await patch(`/api/inquiries/${i2.id}`,{status:'quoted',...own});
  check('R4.3','new → quoted',{method:'PATCH',url:`/api/inquiries/${i2.id}`,body:{status:'quoted'}},'status quoted', (r.body?.inquiry?.status||(await get(`/api/inquiries/${i2.id}?role=owner`)).body?.inquiry?.status)==='quoted', {status:r.status,s:r.body?.inquiry?.status});
  r=await patch(`/api/inquiries/${i2.id}`,{status:'won',...own});
  check('R4.3','quoted → won',{method:'PATCH',url:`/api/inquiries/${i2.id}`,body:{status:'won'}},'status won', (r.body?.inquiry?.status||(await get(`/api/inquiries/${i2.id}?role=owner`)).body?.inquiry?.status)==='won', {status:r.status,s:r.body?.inquiry?.status});
  const countOrders=async()=> ((await get('/api/orders?role=owner')).body.orders||[]).filter(o=>o.quality===Q && o.party_id===p3.id).length;
  const rc=await Promise.all([1,2,3].map(()=>post(`/api/inquiries/${i2.id}/convert`,{rate_per_m:88,promise_date:'2026-10-20',...own})));
  const ords=((await get('/api/orders?role=owner')).body.orders||[]).filter(o=>o.quality===Q && o.party_id===p3.id);
  check('R4.3','Won inquiry converted (3 parallel convert calls) → exactly one order with party, quality, 400 m',{method:'POST ×3 parallel',url:`/api/inquiries/${i2.id}/convert`},'1 order, party '+P3+', meters 400', ords.length===1 && Number(ords[0].meters)===400, {statuses:rc.map(x=>x.status),orders:ords.map(o=>[o.id,o.party_name,o.meters])});
  r=await post(`/api/inquiries/${i2.id}/convert`,{rate_per_m:88,...own});
  check('R4.3','Converting again (sequential) does not create a second order',{method:'POST',url:`/api/inquiries/${i2.id}/convert`},'still 1 order', await countOrders()===1 && r.status<500, {status:r.status,count:await countOrders()});
  r=await post(`/api/inquiries/99999999/convert`,{...own});
  check('Access/bad-input','Convert unknown inquiry → 4xx',{method:'POST',url:'/api/inquiries/99999999/convert'},'4xx', is4xx(r.status), {status:r.status});
  r=await post('/api/inquiries',{raw_text:`need 50 m ${Q}`,party_name:P2,...own});
  const i3=r.body.inquiry;
  await patch(`/api/inquiries/${i3.id}`,{status:'quoted',...own});
  r=await patch(`/api/inquiries/${i3.id}`,{status:'lost',...own});
  check('R4.3','quoted → lost',{method:'PATCH',url:`/api/inquiries/${i3.id}`,body:{status:'lost'}},'lost', (await get(`/api/inquiries/${i3.id}?role=owner`)).body?.inquiry?.status==='lost', {status:r.status});
  r=await post(`/api/inquiries/${i3.id}/convert`,{...own});
  rec('R4.3','Convert a LOST inquiry',{method:'POST',url:`/api/inquiries/${i3.id}/convert`},'unspecified (only won is said to convert)',{status:r.status,body:r.body?.error||('order '+r.body?.order?.id)},'ambiguous');
  r=await post('/api/inquiries',{raw_text:'hello, any stock?',...own});
  rec('R4.1','Text with no quality/meters',{method:'POST',url:'/api/inquiries',body:{raw_text:'hello, any stock?'}},'stored; nothing extracted',{status:r.status,q:r.body?.inquiry?.quality,m:r.body?.inquiry?.meters},'ambiguous');
}

// ================= R5.3 / R13 SUGGESTIONS =================
{
  const Q=S+'-QU', U1=S+'-U1'; await IN(U1,Q,500);
  const tomorrow=new Date(Date.now()+86400000).toISOString().slice(0,10);
  const ou=(await order(P1,Q,300,{promise_date:tomorrow})).body.order;
  await post('/api/agents/run',{role:'owner'});
  let r=await get('/api/agents/suggestions?role=owner');
  let sg=r.body.suggestions||[];
  const forOrder=sg.filter(s=>(s.target_type==='order' && String(s.target_id)===String(ou.id)) || (s.payload && (s.payload.order_id===ou.id||s.payload.orderId===ou.id)));
  check('R5.3','Order due tomorrow with 0 allocated (stock available) raises suggestion targeting it',{method:'GET',url:'/api/agents/suggestions?role=owner'},'≥1 suggestion for order '+ou.id, forOrder.length>=1, forOrder.map(s=>[s.id,s.kind,s.title,s.action_label]));
  // dedupe
  await post('/api/agents/run',{role:'owner'}); await post('/api/agents/run',{role:'owner'});
  r=await get('/api/agents/suggestions?role=owner'); sg=r.body.suggestions||[];
  const keys={}; for(const s of sg){ const k=[s.agent,s.kind,s.target_type,s.target_id].join('|'); keys[k]=(keys[k]||0)+1; }
  const dups=Object.entries(keys).filter(([k,v])=>v>1);
  check('R13.2','Running scan 3× produces no duplicate open suggestion (same agent/kind/target)',{method:'POST ×2 /api/agents/run then GET',url:'/api/agents/suggestions?role=owner'},'no duplicates', dups.length===0, dups.slice(0,5));
  // accept allocation suggestion
  const acc=(r.body.suggestions||[]).find(s=>(s.target_type==='order' && String(s.target_id)===String(ou.id)) && s.action_label);
  if(acc){
    const rr=await post('/api/agents/suggestions',{id:acc.id,action:'accept',...own});
    const g=await oget(ou.id); const res=(g.body.allocations||[]).filter(a=>a.status==='reserved').reduce((s,a)=>s+Number(a.meters),0);
    check('R13.3','Accept allocation suggestion creates reservation (300 m for order)',{method:'POST',url:'/api/agents/suggestions',body:{id:acc.id,action:'accept'}},'order reserved 300', res===300, {status:rr.status,reserved:res,sugg:acc.title});
    const rr2=await post('/api/agents/suggestions',{id:acc.id,action:'accept',...own});
    const g2=await oget(ou.id); const res2=(g2.body.allocations||[]).filter(a=>a.status==='reserved').reduce((s,a)=>s+Number(a.meters),0);
    check('R13.3/R6.3','Accepting the same suggestion again does not double-reserve',{method:'POST',url:'/api/agents/suggestions',body:{id:acc.id,action:'accept'}},'reserved stays 300', res2===300 && rr2.status<500, {status:rr2.status,reserved:res2});
  } else rec('R13.3','No actionable allocation suggestion found for order due tomorrow',{method:'GET',url:'/api/agents/suggestions'},'an actionable suggestion to accept',forOrder.map(s=>s.title),'fail');
  // reject + quiet period
  const Q2=S+'-QQ'; const oq=(await order(P2,Q2,777)).body.order; // no stock → short_for_orders for quality
  await post('/api/agents/run',{role:'owner'});
  r=await get('/api/agents/suggestions?role=owner');
  const rej=(r.body.suggestions||[]).find(s=>s.target_id===Q2 || String(s.target_id)===String(oq.id) || (s.title||'').includes(Q2));
  if(rej){
    const rr=await post('/api/agents/suggestions',{id:rej.id,action:'reject',...own});
    await post('/api/agents/run',{role:'owner'});
    const after=(await get('/api/agents/suggestions?role=owner')).body.suggestions||[];
    const back=after.filter(s=>s.kind===rej.kind && String(s.target_id)===String(rej.target_id));
    check('R13.3','Rejected suggestion does not reappear after re-scan',{method:'POST',url:'/api/agents/suggestions',body:{id:rej.id,action:'reject'}},'not in list after rescan', rr.status<300 && back.length===0, {status:rr.status,back:back.map(s=>[s.id,s.title])});
  } else rec('R13.1','No suggestion found for quality with open order and zero stock',{method:'GET',url:'/api/agents/suggestions'},'suggestion present','none','fail');
  r=await post('/api/agents/suggestions',{id:99999999,action:'accept',...own});
  check('Access/bad-input','Accept unknown suggestion id → 4xx',{method:'POST',url:'/api/agents/suggestions',body:{id:99999999,action:'accept'}},'4xx', is4xx(r.status), {status:r.status,body:r.body});
  const anyS=((await get('/api/agents/suggestions?role=owner')).body.suggestions||[])[0];
  r=await post('/api/agents/suggestions',{id:anyS?.id,action:'explode',...own});
  check('Access/bad-input','Invalid suggestion action → 4xx',{method:'POST',url:'/api/agents/suggestions',body:{action:'explode'}},'4xx', is4xx(r.status), {status:r.status,body:r.body});
  r=await post('/api/agents/suggestions',{action:'accept',...own});
  check('Access/bad-input','Missing suggestion id → 4xx',{method:'POST',url:'/api/agents/suggestions',body:{action:'accept'}},'4xx', is4xx(r.status), {status:r.status,body:r.body});
  // supervisor visibility
  r=await get('/api/agents/suggestions?role=supervisor');
  const ss=r.body.suggestions||[];
  const lk=moneyLeaks(ss); const oo=ss.filter(s=>s.owner_only);
  check('R13.4','Supervisor suggestions contain no money-related items / ₹ values',{method:'GET',url:'/api/agents/suggestions?role=supervisor'},'no owner_only items, no ₹', r.status===200 && lk.length===0 && oo.length===0, {count:ss.length,leaks:lk.slice(0,5),ownerOnly:oo.length,agents:[...new Set(ss.map(s=>s.agent))]});
  const ownS=(await get('/api/agents/suggestions?role=owner')).body.suggestions||[];
  const moneyOwn=ownS.filter(s=>s.owner_only);
  if(moneyOwn[0]){
    r=await post('/api/agents/suggestions',{id:moneyOwn[0].id,action:'reject',...sup});
    check('R13.4','Supervisor cannot act on an owner-only (money) suggestion',{method:'POST',url:'/api/agents/suggestions',body:{id:moneyOwn[0].id,action:'reject',role:'supervisor'}},'403/4xx', is4xx(r.status), {status:r.status});
  } else rec('R13.4','No owner-only suggestion present to probe supervisor action',{},'n/a','none','ambiguous');
  r=await get('/api/agents/suggestions?role=worker');
  check('R13.5','Worker sees no suggestions',{method:'GET',url:'/api/agents/suggestions?role=worker'},'403 or empty list', r.status===403 || (r.body.suggestions||[]).length===0, {status:r.status,n:(r.body.suggestions||[]).length});
  r=await get('/api/agents/suggestions');
  check('R13.5','No role (=worker) sees no suggestions',{method:'GET',url:'/api/agents/suggestions'},'403 or empty', r.status===403 || (r.body.suggestions||[]).length===0, {status:r.status,n:(r.body.suggestions||[]).length});
  if(ownS[0]){ r=await post('/api/agents/suggestions',{id:ownS[0].id,action:'reject',...wrk});
    check('R13.5','Worker cannot accept/reject suggestions',{method:'POST',url:'/api/agents/suggestions',body:{role:'worker',action:'reject'}},'403', r.status===403, {status:r.status}); }
  r=await post('/api/agents/run',{role:'worker'});
  check('Access','Worker cannot force agent scan',{method:'POST',url:'/api/agents/run',body:{role:'worker'}},'403', r.status===403, {status:r.status});
}

// ================= R14 CHAT =================
{
  const ask=(q,role='owner')=>post('/api/chat',{question:q,role,user_id:role==='owner'?'usr-owner':'usr-demo-sup'});
  const nums=s=>(String(s).replace(/,/g,'').match(/\d+(\.\d+)?/g)||[]).map(Number);
  const w=(await get('/api/workers')).body.workers.filter(x=>x.active!==false).length;
  let r=await ask('how many workers do I have');
  check('R14.1','"how many workers do I have" = active workers from /api/workers ('+w+')',{method:'POST',url:'/api/chat',body:{question:'how many workers do I have'}},String(w), nums(r.body?.answer)[0]===w, r.body?.answer);
  r=await ask('how many supervisors');
  const sn=nums(r.body?.answer)[0];
  rec('R14.1','"how many supervisors" — no API lists supervisors; SPEC demo users imply 1',{method:'POST',url:'/api/chat',body:{question:'how many supervisors'}},'1 (demo users) — unverifiable',r.body?.answer, sn===1?'ambiguous':'ambiguous');
  const orders=(await get('/api/orders?role=owner')).body.orders;
  const nOpen=orders.filter(o=>o.status==='open').length, nOpenPart=orders.filter(o=>['open','partly_dispatched'].includes(o.status)).length;
  r=await ask('how many open orders');
  const an=nums(r.body?.answer);
  const v = an.includes(nOpen) ? 'pass' : (an.includes(nOpenPart)?'ambiguous':'fail');
  rec('R14.1','"how many open orders" = count of status open from /api/orders ('+nOpen+'; open+partly='+nOpenPart+')',{method:'POST',url:'/api/chat',body:{question:'how many open orders'}},String(nOpen),r.body?.answer,v);
  // outstanding
  const inv=(await get('/api/invoices?role=owner')).body; const pay=(await get('/api/payments?role=owner')).body;
  const invs=(inv.invoices||[]).filter(i=>i.status!=='cancelled'); const pays=(pay.payments||[]);
  const outst=Math.round(invs.reduce((s,i)=>s+Number(i.total||0),0)-pays.reduce((s,p)=>s+Number(p.amount||0),0));
  r=await ask('what is the total outstanding amount');
  const on=nums(r.body?.answer);
  check('R14.1','Owner "outstanding amount" = Σ invoice totals − Σ payments ('+outst+')',{method:'POST',url:'/api/chat',body:{question:'what is the total outstanding amount'}},String(outst), on.some(x=>Math.abs(x-outst)<=1), {answer:r.body?.answer,invoices:invs.length,payments:pays.length});
  r=await ask('what is the total outstanding amount','supervisor');
  check('R14.2','Supervisor money question → no ₹ figure',{method:'POST',url:'/api/chat',body:{question:'what is the total outstanding amount',role:'supervisor'}},'no ₹ and no outstanding number', !/₹|Rs\.?\s?\d/.test(JSON.stringify(r.body)) && !(nums(JSON.stringify(r.body)).some(x=>Math.abs(x-outst)<=1) && outst>0) && moneyLeaks(r.body).length===0, {status:r.status,body:JSON.stringify(r.body).slice(0,250)});
  r=await ask('what rate do we charge for Georgette','supervisor');
  check('R14.2','Supervisor rate question → no ₹ figure',{method:'POST',url:'/api/chat',body:{question:'what rate do we charge for Georgette',role:'supervisor'}},'no ₹', !/₹|Rs\.?\s?\d/.test(JSON.stringify(r.body)) && moneyLeaks(r.body).length===0, {status:r.status,body:JSON.stringify(r.body).slice(0,250)});
  r=await post('/api/chat',{question:'',role:'owner',user_id:'usr-owner'});
  check('Access/bad-input','Empty chat question → 4xx',{method:'POST',url:'/api/chat',body:{question:''}},'4xx', is4xx(r.status), {status:r.status,body:r.body});
  r=await post('/api/chat',{role:'owner'});
  check('Access/bad-input','Missing chat question → 4xx (not 500)',{method:'POST',url:'/api/chat',body:{}},'4xx', is4xx(r.status), {status:r.status,body:r.body});
}

fs.writeFileSync(new URL('./results.json', import.meta.url), JSON.stringify(results,null,2));
const c={pass:0,fail:0,ambiguous:0}; results.forEach(r=>c[r.verdict]++); console.log(c);
for(const r of results.filter(r=>r.verdict!=='pass')) console.log(r.verdict.toUpperCase(), r.id, r.spec_rule, r.description, '|', JSON.stringify(r.request).slice(0,200), '| exp:', r.expected, '| act:', r.actual);
