import {call,gstin,gstinCheck,randPan} from './lib.mjs';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';

const RUN = Date.now().toString(36).toUpperCase().slice(-5);
const O = {role:'owner',actor:'usr-owner'};
const SUP = {role:'supervisor',actor:'usr-demo-sup'};
const WRK = {role:'worker',actor:'usr-demo-wrk'};
const results = [];
let n = 0;
function rec(rule, description, request, expected, actual, verdict){
  const id = 'M' + String(++n).padStart(3,'0');
  results.push({id, spec_rule: rule, description, request, expected, actual, verdict});
  console.log(id, verdict.toUpperCase().padEnd(9), rule, '|', description, verdict!=='pass' ? ('| exp: '+JSON.stringify(expected)+' | act: '+JSON.stringify(actual).slice(0,300)) : '');
}
const r2 = x => Math.round(x*100)/100;
const near = (a,b,tol=0.005) => typeof a==='number' && Math.abs(a-b) <= tol + 1e-9;
const is4xx = s => s>=400 && s<500;
const req = (m,u,b) => ({method:m,url:u,body:b});
function addDays(d, k){ const t = new Date(d+'T00:00:00Z'); t.setUTCDate(t.getUTCDate()+k); return t.toISOString().slice(0,10); }
const TODAY = '2026-09-28';
const num = s => { const m = String(s).match(/(\d+)\s*$/); return m ? parseInt(m[1],10) : NaN; };

// ---------- helpers for test calls ----------
async function expect4xx(rule, desc, m, u, b){
  const r = await call(m,u,b);
  const errOk = r.json && typeof r.json.error === 'string';
  rec(rule, desc, req(m,u,b), '4xx with {error}', `${r.status} ${r.text.slice(0,160)}`, is4xx(r.status) && errOk ? 'pass' : 'fail');
  return r;
}

// ---------- SETUP: billing ----------
const GST = 12;
const firmGstin = gstin('24','AABCB'+'1111B'.slice(0));
let r = await call('PUT','/api/settings/billing',{...O,legal_name:'BBM Firm '+RUN,gstin:firmGstin,state_code:'24',address:'Ring Rd',city:'Surat',phone:'9999999999',gst_rate_pct:GST,hsn_code:'5407',invoice_prefix:'BBM',bank_name:'BBM Bank',bank_account:'123456789012',bank_ifsc:'HDFC0000001',low_stock_m:100,ageing_days:60});
if (r.status!==200) { console.log('billing setup failed', r.status, r.text); process.exit(1); }

// ---------- R2 Parties ----------
const P = n => `BBM-${n}-${RUN}`;
async function mkParty(name, extra){ const b={...O,name,...extra}; const x=await call('POST','/api/parties',b); return {x,b}; }

let {x:pa, b:paB} = await mkParty(P('Intra'), {gstin:gstin('24',randPan()), state_code:'24', credit_limit:100000, credit_days:15, city:'Surat'});
rec('R2.2','Create party with valid GSTIN (state 24)',req('POST','/api/parties',paB),'2xx, party created',`${pa.status}`, pa.status<300 && pa.json?.party?.id ? 'pass':'fail');
const PA = pa.json?.party;
let {x:pb, b:pbB} = await mkParty(P('Inter'), {gstin:gstin('27',randPan()), state_code:'27', credit_limit:200000});
rec('R2.3','credit_days defaults to 30 when not given',req('POST','/api/parties',pbB),'credit_days=30',pb.json?.party?.credit_days, pb.json?.party?.credit_days===30?'pass':'fail');
const PB = pb.json?.party;
let {x:pc} = await mkParty(P('NoLimit'), {state_code:'24', credit_days:20});
const PC = pc.json?.party;
let {x:pf} = await mkParty(P('Fifo'), {gstin:gstin('24',randPan()), state_code:'24', credit_limit:50000, credit_days:10});
const PF = pf.json?.party;
if (!PA||!PB||!PC||!PF){ console.log('party setup failed', pb.text, pc.text, pf.text); process.exit(1); }

// invalid GSTINs
{
  const good = gstin('24', randPan());
  const badCheck = good.slice(0,14) + (good[14]==='A'?'B':'A');
  await expect4xx('R2.2','GSTIN with wrong check character refused','POST','/api/parties',{...O,name:P('BadChk'),gstin:badCheck});
  await expect4xx('R2.2','GSTIN of 14 characters refused','POST','/api/parties',{...O,name:P('Short'),gstin:good.slice(0,14)});
  const s14 = '24'+randPan()+'1Y'; // 14th char not Z, valid check char
  await expect4xx('R2.2','GSTIN whose 14th char is not Z (valid checksum) refused','POST','/api/parties',{...O,name:P('NoZ'),gstin:s14+gstinCheck(s14)});
  const badPan = '24'+'12345ABCDE'+'1Z'; // PAN letters/digits swapped, valid check char
  await expect4xx('R2.2','GSTIN with malformed PAN (valid checksum) refused','POST','/api/parties',{...O,name:P('BadPan'),gstin:badPan+gstinCheck(badPan)});
  const badState = 'AB'+randPan()+'1Z';
  await expect4xx('R2.2','GSTIN with non-numeric state code refused','POST','/api/parties',{...O,name:P('BadSt'),gstin:badState+gstinCheck(badState)});
  await expect4xx('R2.2','PATCH party with invalid GSTIN refused','PATCH',`/api/parties/${PC.id}`,{...O,gstin:badCheck});
  // duplicates
  await expect4xx('R2.1','Duplicate party name (exact) refused','POST','/api/parties',{...O,name:P('Intra')});
  await expect4xx('R2.1','Duplicate party name differing in case + surrounding spaces refused','POST','/api/parties',{...O,name:'  '+P('Intra').toLowerCase()+'  '});
  await expect4xx('R2.1','PATCH rename party to existing name (different case) refused','PATCH',`/api/parties/${PC.id}`,{...O,name:P('Inter').toUpperCase()+' '});
  const g = await call('GET',`/api/parties?role=owner&q=${encodeURIComponent('bbm-intra-'+RUN.toLowerCase())}`);
  const cnt = (g.json?.parties||[]).filter(p=>p.name.trim().toLowerCase()===P('Intra').toLowerCase()).length;
  rec('R2.1','Only one party with the Intra name exists after duplicate attempts',req('GET',`/api/parties?q=...`),1,cnt,cnt===1?'pass':'fail');
}

// ---------- R3 Rates ----------
const Q = `BBM-Q-${RUN}`;
const Q2 = `BBM-Q2-${RUN}`;
const QF = `BBM-QF-${RUN}`, Q4 = `BBM-Q4-${RUN}`;
{
  const posts = [
    {quality:Q, rate_per_m:100, valid_from:'2026-01-01'},
    {quality:Q, rate_per_m:110, valid_from:'2026-06-01'},
    {quality:Q, rate_per_m:999, valid_from:'2027-01-01'},
    {quality:Q, party_id:PA.id, rate_per_m:90, valid_from:'2026-02-01'},
    {quality:Q, party_id:PA.id, rate_per_m:50, valid_from:'2027-03-01'},
    {quality:Q2, rate_per_m:200, valid_from:'2026-01-01'},
    {quality:QF, rate_per_m:100, valid_from:'2026-01-01'},
    {quality:Q4, rate_per_m:80, valid_from:'2026-01-01'},
  ];
  for (const p of posts){ const x = await call('POST','/api/rates',{...O,...p}); if (x.status>=300) console.log('rate post fail',x.status,x.text); }
  let x = await call('GET',`/api/orders/rate?quality=${encodeURIComponent(Q)}&party_id=${PB.id}&role=owner`);
  rec('R3.2','General rate: latest valid_from <= today wins, future (2027) rate ignored',req('GET',x&&`/api/orders/rate?quality=${Q}&party_id=${PB.id}`),110,x.json?.rate,x.json?.rate===110?'pass':'fail');
  x = await call('GET',`/api/orders/rate?quality=${encodeURIComponent(Q)}&party_id=${PA.id}&role=owner`);
  rec('R3.2','Party-specific rate (90, from 2026-02-01) beats newer general rate (110); future party rate ignored',req('GET',`/api/orders/rate?quality=${Q}&party_id=${PA.id}`),90,x.json?.rate,x.json?.rate===90?'pass':'fail');
  x = await call('GET',`/api/orders/rate?quality=${encodeURIComponent(Q)}&party=${encodeURIComponent(P('Intra'))}&role=owner`);
  rec('R3.2','Rate lookup by party name gives same party-specific rate',req('GET',`/api/orders/rate?quality=${Q}&party=${P('Intra')}`),90,x.json?.rate,x.json?.rate===90?'pass':'fail');
  // only-future rate
  const Q3 = `BBM-Q3-${RUN}`;
  await call('POST','/api/rates',{...O,quality:Q3,rate_per_m:77,valid_from:'2027-05-01'});
  x = await call('GET',`/api/orders/rate?quality=${encodeURIComponent(Q3)}&party_id=${PB.id}&role=owner`);
  rec('R3.2','Quality with only a future-dated rate has no rate today',req('GET',`/api/orders/rate?quality=${Q3}&party_id=${PB.id}`),'no rate (null/absent)',x.json, (x.json?.rate==null) ? 'pass':'fail');
  await expect4xx('R3.1','Negative rate refused','POST','/api/rates',{...O,quality:Q,rate_per_m:-5,valid_from:'2026-01-01'});
  await expect4xx('R3.1','Non-numeric rate refused','POST','/api/rates',{...O,quality:Q,rate_per_m:'abc',valid_from:'2026-01-01'});
  await expect4xx('R3.1','Invalid valid_from date refused','POST','/api/rates',{...O,quality:Q,rate_per_m:10,valid_from:'2026-13-45'});
}
// ---------- R3.3 process costs ----------
{
  let c = await call('GET','/api/costs?role=owner');
  const sec = c.json?.sections?.[0]?.section;
  let x1 = await call('POST','/api/costs',{...O,section:sec,cost_per_m:1.75,valid_from:'2026-09-01'});
  let x2 = await call('POST','/api/costs',{...O,section:sec,cost_per_m:9.5,valid_from:'2027-02-01'});
  c = await call('GET','/api/costs?role=owner');
  const cur = c.json?.sections?.find(s=>s.section===sec)?.cost_per_m;
  rec('R3.3',`Process cost for section ${sec}: latest valid_from <= today (1.75) is current; future 9.5 not used`,req('POST','/api/costs',{section:sec,cost_per_m:'1.75 @2026-09-01, 9.5 @2027-02-01'}),1.75,{post1:x1.status,post2:x2.status,current:cur},cur===1.75?'pass':'fail');
  await expect4xx('R3.3','Negative process cost refused','POST','/api/costs',{...O,section:sec,cost_per_m:-1,valid_from:'2026-09-01'});
  await expect4xx('R3.3','Non-numeric process cost refused','POST','/api/costs',{...O,section:sec,cost_per_m:'x',valid_from:'2026-09-01'});
}

// ---------- R10 costing (lots with shortage created before report baseline) ----------
const LS = `BBM-LS-${RUN}`, LN = `BBM-LN-${RUN}`;
{
  const a = await call('POST','/api/stock',{...O,direction:'IN',lot_id:LS,quality:Q2,design:'D',grey_meters:200,finished_meters:160,mill_name:'BBM Mill',purchase_rate:40,moved_by:'usr-owner'});
  const b = await call('POST','/api/stock',{...O,direction:'IN',lot_id:LN,quality:Q2,design:'D',grey_meters:200,finished_meters:200,mill_name:'BBM Mill',purchase_rate:40,moved_by:'usr-owner'});
  const cs = await call('GET',`/api/costs/lot?lot_id=${LS}&role=owner`);
  const cn = await call('GET',`/api/costs/lot?lot_id=${LN}&role=owner`);
  const ts = cs.json?.cost?.total, tn = cn.json?.cost?.total;
  const pn = cn.json?.cost?.process_total ?? 0;
  rec('R10.1','No-shortage lot: cost/m = purchase 40 + its process costs',req('GET',`/api/costs/lot?lot_id=${LN}`),`40 + process_total(${pn}) = ${40+pn}`,cn.json?.cost, near(tn,40+pn,0.01)?'pass':'fail');
  rec('R10.1','Shortage lot (grey 200, finished 160) costs more per finished m than identical no-shortage lot',req('GET',`/api/costs/lot?lot_id=${LS}`),`> ${tn} (e.g. 40*200/160=50 + process)`,cs.json?.cost, (typeof ts==='number' && ts>tn)?'pass':'fail');
  const exp = 40*200/160 + (cs.json?.cost?.process_total ?? 0);
  rec('R10.1','Shortage lot exact cost (formula combination not fully specified)',req('GET',`/api/costs/lot?lot_id=${LS}`),`~${r2(exp)} if purchase scaled by grey/finished`,ts,'ambiguous');
  const pc0 = cn.json?.cost?.process;
  rec('R10.1','Which process costs are "applicable" to a lot with no job cards',req('GET',`/api/costs/lot?lot_id=${LN}`),'unspecified',{process:pc0,process_total:pn},'ambiguous');
  if (a.status>=300||b.status>=300) console.log('lot setup', a.text, b.text);
}

// ---------- report baseline ----------
const rep0 = {};
for (const p of ['day','week','month']) { const x = await call('GET',`/api/reports?period=${p}&date=${TODAY}&role=owner`); rep0[p]=x.json?.stock; }
let myIn = 0, myOut = 0;

// ---------- stock for invoices ----------
const L1 = `BBM-L1-${RUN}`, L2 = `BBM-L2-${RUN}`, LF = `BBM-LF-${RUN}`, LM = `BBM-LM-${RUN}`;
for (const [lot,m,q] of [[L1,1000,Q],[L2,500,Q],[LF,300,QF],[LM,300,Q4]]) {
  const x = await call('POST','/api/stock',{...O,direction:'IN',lot_id:lot,quality:q,design:'D',grey_meters:m,finished_meters:m,mill_name:'BBM Mill',purchase_rate:40,moved_by:'usr-owner'});
  if (x.status>=300) { console.log('stock fail',x.text); process.exit(1);} myIn += m;
}
async function dispatch(party, lines, extra={}){ const b={...O,party,lines,transporter:'BBM Trans',lr_no:'LR1',vehicle_no:'GJ05AB1234',packages:2,...extra}; const x=await call('POST','/api/dispatches',b); if (x.status<300) myOut += lines.reduce((s,l)=>s+l.meters,0); return {x,b}; }

// ---------- R8 invoices ----------
const billing0 = (await call('GET','/api/settings/billing?role=owner')).json?.billing;
const nextNo = billing0?.next_invoice_no;
const dA = await dispatch(P('Intra'), [{lot_id:L1, meters:123.45}]);
const DA = dA.x.json?.dispatch?.id;
let iA = await call('POST','/api/invoices',{...O,dispatch_id:DA});
const IA = iA.json?.invoice;
{
  const tax = r2(123.45*90), half = r2(tax*GST/200), tot = tax + 2*half;
  const b = {...O,dispatch_id:DA};
  rec('R8.1','Create invoice from dispatch (intra-state party)',req('POST','/api/invoices',b),'2xx',iA.status,iA.status<300&&IA?'pass':'fail');
  rec('R8.2','Taxable = 123.45 m x party rate 90',req('POST','/api/invoices',b),tax,IA?.taxable_amount,near(IA?.taxable_amount,tax)?'pass':'fail');
  rec('R8.3','Intra-state: CGST = SGST = 6% of taxable, IGST = 0',req('POST','/api/invoices',b),{cgst:half,sgst:half,igst:0},{cgst:IA?.cgst,sgst:IA?.sgst,igst:IA?.igst},(near(IA?.cgst,half)&&near(IA?.sgst,half)&&!IA?.igst)?'pass':'fail');
  rec('R8.4','Total = taxable + taxes (±0.50)',req('POST','/api/invoices',b),tot,IA?.total,near(IA?.total,tot,0.5)?'pass':'fail');
  rec('R8.6','Due date = invoice date + 15 credit days',req('POST','/api/invoices',b),addDays(TODAY,15),IA?.due_date,IA?.due_date===addDays(TODAY,15)?'pass':'fail');
  rec('R8.5','First invoice number uses configured next_invoice_no',req('GET','/api/settings/billing'),nextNo,IA?.invoice_no,num(IA?.invoice_no)===nextNo?'pass':'fail');
  await expect4xx('R8.7','Invoicing the same dispatch twice refused','POST','/api/invoices',b);
}
const dB = await dispatch(P('Inter'), [{lot_id:L1, meters:77.7}]);
const DB = dB.x.json?.dispatch?.id;
let iB = await call('POST','/api/invoices',{...O,dispatch_id:DB});
const IB = iB.json?.invoice;
{
  const tax = r2(77.7*110), ig = r2(tax*GST/100), tot = tax+ig;
  const b = {...O,dispatch_id:DB};
  rec('R8.2','Inter-state taxable = 77.7 m x general rate 110',req('POST','/api/invoices',b),tax,IB?.taxable_amount,near(IB?.taxable_amount,tax)?'pass':'fail');
  rec('R8.3','Inter-state (27 vs 24): IGST = 12%, CGST = SGST = 0',req('POST','/api/invoices',b),{igst:ig,cgst:0,sgst:0},{igst:IB?.igst,cgst:IB?.cgst,sgst:IB?.sgst},(near(IB?.igst,ig)&&!IB?.cgst&&!IB?.sgst)?'pass':'fail');
  rec('R8.4','Inter-state total = taxable + IGST (±0.50)',req('POST','/api/invoices',b),tot,IB?.total,near(IB?.total,tot,0.5)?'pass':'fail');
  rec('R8.6','Due date = date + default 30 credit days',req('POST','/api/invoices',b),addDays(TODAY,30),IB?.due_date,IB?.due_date===addDays(TODAY,30)?'pass':'fail');
  rec('R8.5','Second invoice number = first + 1',req('POST','/api/invoices',b),num(IA?.invoice_no)+1,IB?.invoice_no,num(IB?.invoice_no)===num(IA?.invoice_no)+1?'pass':'fail');
}
// Tally invoice in between
const TNO = `BBM-T-${RUN}`;
{
  const b = {...O,source:'tally',invoice_no:TNO,party:P('Inter'),invoice_date:'2026-09-20',taxable_amount:1000,total:1180,lines:[{quality:Q,meters:10,rate:100}]};
  const x = await call('POST','/api/invoices',b);
  rec('R8.1','Record Tally invoice (source=tally)',req('POST','/api/invoices',b),'2xx, source tally, number kept',`${x.status} ${x.json?.invoice?.source} ${x.json?.invoice?.invoice_no}`,(x.status<300&&x.json?.invoice?.source==='tally'&&x.json?.invoice?.invoice_no===TNO)?'pass':'fail');
  const l = await call('GET',`/api/invoices?source=tally&party_id=${PB.id}&role=owner`);
  const found = (l.json?.invoices||[]).some(i=>i.invoice_no===TNO);
  rec('R8.1','Tally invoice listed under source=tally filter',req('GET',`/api/invoices?source=tally&party_id=${PB.id}`),true,found,found?'pass':'fail');
  const d = x.json?.invoice?.due_date;
  rec('R8.6','Tally invoice without due_date: due = date + 30 days (party default)',req('POST','/api/invoices',b),addDays('2026-09-20',30),d,'ambiguous');
  const dup = await call('POST','/api/invoices',b);
  rec('R8.5','Tally invoice with an already-used invoice_no',req('POST','/api/invoices',b),'unspecified (made-here uniqueness only)',`${dup.status} ${dup.text.slice(0,120)}`, dup.status>=500?'fail':'ambiguous');
  await expect4xx('R8.1','Tally invoice with non-numeric total refused','POST','/api/invoices',{...b,invoice_no:TNO+'X',total:'abc'});
  await expect4xx('R8.1','Tally invoice with invalid date refused','POST','/api/invoices',{...b,invoice_no:TNO+'Y',invoice_date:'2026-02-30'});
}
// Invoice C with rate override, via create_invoice on dispatch
let IC;
{
  const dC = await dispatch(P('Intra'), [{lot_id:L2, meters:10}], {create_invoice:true, rates:{[Q]:95.55}});
  IC = dC.x.json?.invoice ?? null;
  if (!IC && dC.x.json?.dispatch?.invoice_id) IC = (await call('GET',`/api/invoices/${dC.x.json.dispatch.invoice_id}?role=owner`)).json?.invoice;
  const tax = 955.5, half = r2(tax*0.06);
  rec('R8.1','Dispatch with create_invoice=true and rate override creates invoice',req('POST','/api/dispatches',dC.b),'2xx + invoice',`${dC.x.status} inv=${IC?.invoice_no}`,IC?'pass':'fail');
  rec('R8.2','Rate override rates:{quality:95.55} on dispatch (override semantics not in spec; lookup rate would be 90)',req('POST','/api/dispatches',dC.b),'955.50 if override honoured, 900 if lookup',IC?.taxable_amount,'ambiguous');
  { const t=IC?.taxable_amount, h=r2(t*0.06); rec('R8.3/8.4','Invoice C: CGST=SGST=6% of its taxable, total = taxable+taxes',req('POST','/api/dispatches',dC.b),{cgst:h,sgst:h,total:r2(t+2*h)},{cgst:IC?.cgst,sgst:IC?.sgst,total:IC?.total},(near(IC?.cgst,h)&&near(IC?.sgst,h)&&!IC?.igst&&near(IC?.total,t+2*h,0.5))?'pass':'fail'); }
  rec('R8.5','Next made-here invoice consecutive after Tally invoice recorded (B+1)',req('POST','/api/dispatches',dC.b),num(IB?.invoice_no)+1,IC?.invoice_no,num(IC?.invoice_no)===num(IB?.invoice_no)+1?'pass':'fail');
  const DC = dC.x.json?.dispatch?.id;
  await expect4xx('R8.7','Dispatch already invoiced via create_invoice cannot be invoiced again','POST','/api/invoices',{...O,dispatch_id:DC});
  await expect4xx('R8.1','Invoice for non-existent dispatch refused','POST','/api/invoices',{...O,dispatch_id:99999999});
  const dD = await dispatch(P('Intra'), [{lot_id:L2, meters:5}]);
  await expect4xx('R8.1','Invoice with invalid invoice_date refused','POST','/api/invoices',{...O,dispatch_id:dD.x.json?.dispatch?.id,invoice_date:'not-a-date'});
  { const b={...O,dispatch_id:dD.x.json?.dispatch?.id,rates:{[L2]:-10}}; const x=await call('POST','/api/invoices',b); globalThis.NEGOK = x.status<300; rec('R8.2','Invoice with negative rate override (lot key)',req('POST','/api/invoices',b),'4xx or override ignored (semantics unspecified)',`${x.status} taxable=${x.json?.invoice?.taxable_amount}`, x.status>=500||(x.json?.invoice?.taxable_amount<0)?'fail':'ambiguous'); }
  // concurrency: two parallel invoice attempts for one dispatch
  const dE = await dispatch(P('Intra'), [{lot_id:L2, meters:5}]);
  const DE = dE.x.json?.dispatch?.id;
  const par = await Promise.all([1,2,3].map(()=>call('POST','/api/invoices',{...O,dispatch_id:DE})));
  const okc = par.filter(p=>p.status<300).length;
  rec('R8.7','3 concurrent invoice requests for one dispatch -> exactly one succeeds',req('POST','/api/invoices',{dispatch_id:DE,'x3':'parallel'}),1,par.map(p=>p.status),okc===1?'pass':'fail');
  // consecutive under concurrency: invoice D dispatch + another
  const dF = await dispatch(P('Intra'), [{lot_id:L2, meters:5}]);
  const dG = await dispatch(P('Intra'), [{lot_id:L2, meters:5}]);
  const par2 = await Promise.all([dG.x.json?.dispatch?.id, dF.x.json?.dispatch?.id].map(id=>call('POST','/api/invoices',{...O,dispatch_id:id})));
  const nums = [...par.filter(p=>p.status<300), ...par2].map(p=>num(p.json?.invoice?.invoice_no)).sort((a,b)=>a-b);
  const base = num(IC?.invoice_no) + (globalThis.NEGOK?1:0);
  const expNums = [base+1,base+2,base+3];
  rec('R8.5','Concurrent invoice creation yields unique consecutive numbers',req('POST','/api/invoices','3 parallel dispatch invoices'),expNums,nums,JSON.stringify(nums)===JSON.stringify(expNums)?'pass':'fail');
}
// Cancel
{
  const dX = await dispatch(P('NoLimit'), [{lot_id:L2, meters:20}]);
  const x = await call('POST','/api/invoices',{...O,dispatch_id:dX.x.json?.dispatch?.id});
  const id = x.json?.invoice?.id;
  const before = (await call('GET',`/api/credit?party_id=${PC.id}&role=owner`)).json?.parties?.[0]?.outstanding;
  const c = await call('PATCH',`/api/invoices/${id}`,{...O,status:'cancelled'});
  const g = await call('GET',`/api/invoices/${id}?role=owner`);
  const st = g.json?.invoice?.status;
  rec('R8.1','Cancel invoice via PATCH status=cancelled',req('PATCH',`/api/invoices/${id}`,{status:'cancelled'}),'status cancelled',`${c.status} ${st}`,st==='cancelled'?'pass':'fail');
  const after = (await call('GET',`/api/credit?party_id=${PC.id}&role=owner`)).json?.parties?.[0]?.outstanding ?? 0;
  rec('R9.3','Outstanding after cancelling the party\'s only invoice',req('GET',`/api/credit?party_id=${PC.id}`),'0 (cancelled not owed) - not stated in spec',{before,after},'ambiguous');
  const pay = await call('POST','/api/payments',{...O,party_id:PC.id,amount:100,paid_on:TODAY,mode:'cash',invoice_id:id});
  rec('R9.1','Payment against a cancelled invoice',req('POST','/api/payments',{party_id:PC.id,amount:100,invoice_id:id}),'unspecified',`${pay.status} ${pay.text.slice(0,120)}`,pay.status>=500?'fail':'ambiguous');
}

// ---------- R9 FIFO ----------
let IF = [];
{
  for (const d of ['2026-07-01','2026-08-01','2026-09-25']) {
    const dd = await dispatch(P('Fifo'), [{lot_id:LF, meters:10}]);
    const x = await call('POST','/api/invoices',{...O,dispatch_id:dd.x.json?.dispatch?.id,invoice_date:d});
    IF.push(x.json?.invoice);
  }
  rec('R8.6','Back-dated invoice 2026-07-01, credit days 10 -> due 2026-07-11',req('POST','/api/invoices',{invoice_date:'2026-07-01'}),'2026-07-11',IF[0]?.due_date,IF[0]?.due_date==='2026-07-11'?'pass':'fail');
  rec('R8.2','FIFO invoices each 10 m x general rate 100 = 1000 + 12% = 1120',req('POST','/api/invoices','x3'),[1120,1120,1120],IF.map(i=>i?.total),IF.every(i=>near(i?.total,1120,0.5))?'pass':'fail');
  const cr = async()=> (await call('GET',`/api/credit?party_id=${PF.id}&role=owner`)).json?.parties?.find(p=>p.party_id===PF.id);
  const st = async()=> { const l=(await call('GET',`/api/invoices?party_id=${PF.id}&role=owner`)).json?.invoices||[]; return IF.map(i=>l.find(z=>z.id===i?.id)); };
  let c = await cr();
  rec('R9.3','Outstanding = 3 x 1120 = 3360 before payments',req('GET',`/api/credit?party_id=${PF.id}`),3360,c?.outstanding,near(c?.outstanding,3360)?'pass':'fail');
  rec('R9.3','Overdue = invoices past due (Jul, Aug) = 2240',req('GET',`/api/credit?party_id=${PF.id}`),2240,c?.overdue,near(c?.overdue,2240)?'pass':'fail');
  // reminder
  const rm = await call('GET',`/api/credit/reminder?party_id=${PF.id}&lang=en&role=owner`);
  const t = rm.json?.text || '';
  const mentions = /2,?240|3,?360/.test(t);
  rec('R9.5','Reminder text mentions amount due (2,240 overdue or 3,360 outstanding)',req('GET',`/api/credit/reminder?party_id=${PF.id}&lang=en`),'text contains 2,240 or 3,360',t.slice(0,200),mentions?'pass':'fail');
  for (const lang of ['hi','gu']) { const z = await call('GET',`/api/credit/reminder?party_id=${PF.id}&lang=${lang}&role=owner`); const tt=z.json?.text||''; rec('R9.5',`Reminder (${lang}) mentions amount due`,req('GET',`/api/credit/reminder?party_id=${PF.id}&lang=${lang}`),'contains 2,240 or 3,360 (any digit script)',`${z.status} ${tt.slice(0,120)}`,(/2,?240|3,?360|२,?२४०|३,?३६०|૨,?૨૪૦|૩,?૩૬૦/.test(tt))?'pass':'fail'); }
  // credit check
  let k = await call('GET',`/api/credit/check?party_id=${PF.id}&amount=40000&role=owner`);
  rec('R9.4','Credit check 3360+40000 <= 50000 limit -> ok',req('GET',`/api/credit/check?party_id=${PF.id}&amount=40000`),'ok true',k.json,k.json?.ok===true?'pass':'fail');
  k = await call('GET',`/api/credit/check?party_id=${PF.id}&amount=46640&role=owner`);
  rec('R9.4','Credit check exactly at limit (3360+46640=50000) -> ok (not exceeding)',req('GET',`/api/credit/check?party_id=${PF.id}&amount=46640`),'ok true',k.json,k.json?.ok===true?'pass':'fail');
  k = await call('GET',`/api/credit/check?party_id=${PF.id}&amount=46641&role=owner`);
  rec('R9.4','Credit check 3360+46641 > 50000 -> not ok / warn',req('GET',`/api/credit/check?party_id=${PF.id}&amount=46641`),'ok false or warn',k.json,(k.json?.ok===false||k.json?.warn)?'pass':'fail');
  k = await call('GET',`/api/credit/check?party=${encodeURIComponent(P('Fifo'))}&amount=47000&role=owner`);
  rec('R9.4','Credit check by party name over limit -> not ok',req('GET',`/api/credit/check?party=${P('Fifo')}&amount=47000`),'ok false',k.json,k.json?.ok===false?'pass':'fail');
  {
    const PH = (await mkParty(P('Lim'),{state_code:'24',credit_limit:5000,credit_days:30})).x.json?.party;
    const dh = await dispatch(P('Lim'), [{lot_id:LF, meters:10}]);
    await call('POST','/api/invoices',{...O,dispatch_id:dh.x.json?.dispatch?.id});
    let q = await call('GET',`/api/credit/check?party_id=${PH.id}&amount=3880&role=owner`);
    rec('R9.4','No-overdue party: 1120 outstanding + 3880 = 5000 limit -> ok',req('GET',`/api/credit/check?party_id=${PH.id}&amount=3880`),'ok true',q.json,q.json?.ok===true?'pass':'fail');
    q = await call('GET',`/api/credit/check?party_id=${PH.id}&amount=3881&role=owner`);
    rec('R9.4','No-overdue party: 1120 + 3881 > 5000 -> not ok',req('GET',`/api/credit/check?party_id=${PH.id}&amount=3881`),'ok false or warn',q.json,(q.json?.ok===false||q.json?.warn)?'pass':'fail');
  }
  k = await call('GET',`/api/credit/check?party_id=${PC.id}&amount=99999999&role=owner`);
  rec('R9.4','Credit check with no limit set -> ok',req('GET',`/api/credit/check?party_id=${PC.id}&amount=99999999`),'ok true',k.json,k.json?.ok===true?'pass':'fail');
  k = await call('GET',`/api/credit/check?party_id=${PF.id}&amount=abc&role=owner`);
  rec('Access/bad input','Credit check with non-numeric amount -> 4xx',req('GET',`/api/credit/check?party_id=${PF.id}&amount=abc`),'4xx',`${k.status} ${k.text.slice(0,100)}`,is4xx(k.status)?'pass':'fail');

  // bad payments
  const pb = {...O,party_id:PF.id,paid_on:TODAY,mode:'bank'};
  await expect4xx('R9.1','Payment amount 0 refused','POST','/api/payments',{...pb,amount:0});
  await expect4xx('R9.1','Payment amount negative refused','POST','/api/payments',{...pb,amount:-500});
  await expect4xx('R9.1','Payment amount non-numeric refused','POST','/api/payments',{...pb,amount:'abc'});
  await expect4xx('R9.1','Payment amount missing refused','POST','/api/payments',{...pb});
  await expect4xx('R9.1','Payment date 2026-02-30 refused','POST','/api/payments',{...pb,amount:10,paid_on:'2026-02-30'});
  await expect4xx('R9.1','Payment date not-a-date refused','POST','/api/payments',{...pb,amount:10,paid_on:'yesterday-ish'});
  await expect4xx('R9.1','Payment for unknown party refused','POST','/api/payments',{...pb,party_id:undefined,party:'BBM-NoSuchParty-'+RUN,amount:10});
  await expect4xx('R9.1','Payment amount Infinity-like string refused','POST','/api/payments',{...pb,amount:'1e400'});
  c = await cr();
  rec('R9.1','Refused payments recorded nothing (outstanding still 3360)',req('GET',`/api/credit?party_id=${PF.id}`),3360,c?.outstanding,near(c?.outstanding,3360)?'pass':'fail');

  // payment 1: 1500
  let p = await call('POST','/api/payments',{...pb,amount:1500,reference:'BBM-P1-'+RUN});
  if (p.status>=300) console.log('pay1',p.text);
  rec('R9.1','Record payment 1500',req('POST','/api/payments',{...pb,amount:1500}),'2xx',p.status,p.status<300?'pass':'fail');
  let s = await st(); c = await cr();
  const ss = () => s.map(i=>i?.status);
  const isPaid = x => x==='paid', isPart = x => /part/.test(x||''), isUnpaid = x => x==='unpaid'||x==='open';
  rec('R9.2','After 1500: Jul paid, Aug part-paid, Sep unpaid (FIFO)',req('POST','/api/payments',{amount:1500}),['paid','part-paid','unpaid/open'],ss(),(isPaid(s[0]?.status)&&isPart(s[1]?.status)&&isUnpaid(s[2]?.status))?'pass':'fail');
  rec('R9.2','After 1500: Aug invoice balance 740',req('GET','/api/invoices'),740,s[1]?.balance,near(s[1]?.balance,740)?'pass':'fail');
  rec('R9.3','After 1500: outstanding 1860',req('GET','/api/credit'),1860,c?.outstanding,near(c?.outstanding,1860)?'pass':'fail');
  rec('R9.3','After 1500: overdue 740 (remaining Aug)',req('GET','/api/credit'),740,c?.overdue,near(c?.overdue,740)?'pass':'fail');
  // payment 2: 1000
  p = await call('POST','/api/payments',{...pb,amount:1000,mode:'upi',reference:'BBM-P2-'+RUN});
  s = await st(); c = await cr();
  rec('R9.2','After +1000: Jul paid, Aug paid, Sep part-paid',req('POST','/api/payments',{amount:1000}),['paid','paid','part-paid'],ss(),(isPaid(s[0]?.status)&&isPaid(s[1]?.status)&&isPart(s[2]?.status))?'pass':'fail');
  rec('R9.2','After +1000: Sep balance 860',req('GET','/api/invoices'),860,s[2]?.balance,near(s[2]?.balance,860)?'pass':'fail');
  rec('R9.3','After +1000: outstanding 860, overdue 0',req('GET','/api/credit'),{outstanding:860,overdue:0},{outstanding:c?.outstanding,overdue:c?.overdue},(near(c?.outstanding,860)&&near(c?.overdue??0,0))?'pass':'fail');
  // payment 3: 860
  p = await call('POST','/api/payments',{...pb,amount:860,paid_on:'2026-09-27',mode:'cheque',reference:'BBM-P3-'+RUN});
  s = await st(); c = await cr();
  rec('R9.2','After +860: all three paid',req('POST','/api/payments',{amount:860}),['paid','paid','paid'],ss(),s.every(i=>isPaid(i?.status))?'pass':'fail');
  rec('R9.3','After +860: outstanding 0',req('GET','/api/credit'),0,c?.outstanding??0,near(c?.outstanding??0,0)?'pass':'fail');
  const pl = await call('GET',`/api/payments?party_id=${PF.id}&role=owner`);
  const pays = pl.json?.payments||[];
  const sum = pays.reduce((a,b)=>a+Number(b.amount),0);
  rec('R9.1','Payments list shows exactly 3 payments totalling 3360',req('GET',`/api/payments?party_id=${PF.id}`),{count:3,sum:3360},{count:pays.length,sum},(pays.length===3&&near(sum,3360))?'pass':'fail');
}
// FIFO ordered by invoice date, not creation order
{
  const PG = (await mkParty(P('Fifo2'),{state_code:'24',credit_days:10})).x.json?.party;
  const inv = [];
  for (const d of ['2026-08-15','2026-07-15']) { // newer created first
    const dd = await dispatch(P('Fifo2'), [{lot_id:LF, meters:10}]);
    const x = await call('POST','/api/invoices',{...O,dispatch_id:dd.x.json?.dispatch?.id,invoice_date:d});
    inv.push(x.json?.invoice);
  }
  const p = await call('POST','/api/payments',{...O,party_id:PG.id,amount:1120,paid_on:TODAY,mode:'cash',reference:'BBM-P4-'+RUN});
  const l = (await call('GET',`/api/invoices?party_id=${PG.id}&role=owner`)).json?.invoices||[];
  const older = l.find(i=>i.id===inv[1]?.id), newer = l.find(i=>i.id===inv[0]?.id);
  rec('R9.2','FIFO by invoice date: invoice dated Jul-15 (created second) is settled first',req('POST','/api/payments',{party_id:PG.id,amount:1120}),{jul:'paid',aug:'unpaid/open'},{jul:older?.status,aug:newer?.status},(older?.status==='paid'&&(newer?.status==='open'||newer?.status==='unpaid'))?'pass':'fail');
}

// ---------- R10.2 margin ----------
{
  const PM = (await mkParty(P('Margin'),{state_code:'24'})).x.json?.party;
  const dd = await dispatch(P('Margin'), [{lot_id:LM, meters:100}]);
  const x = await call('POST','/api/invoices',{...O,dispatch_id:dd.x.json?.dispatch?.id});
  const cost = (await call('GET',`/api/costs/lot?lot_id=${LM}&role=owner`)).json?.cost?.total;
  const m = await call('GET','/api/margin?by=party&days=30&role=owner');
  const row = (m.json?.rows||[]).find(r=>r.party_id===PM.id);
  const exp = r2(100*80 - 100*cost);
  rec('R10.2','Margin per party = 100 m x rate 80 - 100 m x lot cost (from /api/costs/lot)',req('GET','/api/margin?by=party&days=30'),{revenue:8000,margin:exp},{revenue:row?.revenue,cost:row?.cost,margin:row?.margin},(near(row?.revenue,8000,0.01)&&near(row?.margin,exp,0.5))?'pass':'fail');
  const mo = await call('GET','/api/margin?by=order&days=30&role=owner');
  rec('R10.2','Margin by order endpoint available',req('GET','/api/margin?by=order'),'200 with rows',mo.status,(mo.status===200&&Array.isArray(mo.json?.rows))?'pass':'fail');
}

// ---------- R8.8 exports ----------
{
  const allNos = [IA?.invoice_no, IB?.invoice_no, IC?.invoice_no].filter(Boolean);
  const x = await call('GET',`/api/invoices/export?format=xml&from=2026-09-01&to=2026-09-30&role=owner`);
  fs.writeFileSync('export.xml', x.buf);
  let parses = false; try { execFileSync('python3',['-c','import xml.etree.ElementTree as E,sys;E.parse(sys.argv[1])','export.xml']); parses = true; } catch(e){}
  rec('R8.8','XML export parses as XML',req('GET','/api/invoices/export?format=xml&from=2026-09-01&to=2026-09-30'),'well-formed XML',`${x.status} ${x.ct} parses=${parses}`,(x.status===200&&parses)?'pass':'fail');
  const missing = allNos.filter(no=>!x.text.includes(no));
  rec('R8.8','XML export contains my invoice numbers',req('GET','/api/invoices/export?format=xml...'),allNos,{missing},missing.length===0?'pass':'fail');
  const hasCancelled = x.text.includes('BBM') ;
  const y = await call('GET',`/api/invoices/export?format=xlsx&from=2026-09-01&to=2026-09-30&role=owner`);
  fs.writeFileSync('export.xlsx', y.buf);
  const pk = y.buf.slice(0,2).toString()==='PK';
  let zipOk=false, contains=false; try { const out = execFileSync('python3',['-c','import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);print(z.testzip());print("\\n".join(z.read(n).decode("utf8","ignore") for n in z.namelist() if n.endswith(".xml")))','export.xlsx']).toString(); zipOk = out.startsWith('None'); contains = allNos.every(no=>out.includes(no)); } catch(e){}
  rec('R8.8','XLSX export is a valid zip starting with PK',req('GET','/api/invoices/export?format=xlsx...'),'PK header, zip test OK',`${y.status} ${y.ct} pk=${pk} zip=${zipOk} bytes=${y.buf.length}`,(y.status===200&&pk&&zipOk)?'pass':'fail');
  rec('R8.8','XLSX export contains my invoice numbers',req('GET','/api/invoices/export?format=xlsx...'),allNos,contains,contains?'pass':'fail');
  const z = await call('GET',`/api/invoices/export?format=pdfx&role=owner`);
  rec('R8.8','Export with unknown format -> 4xx',req('GET','/api/invoices/export?format=pdfx'),'4xx',z.status,is4xx(z.status)?'pass':'fail');
  const w = await call('GET',`/api/invoices/export?format=xml&from=garbage&to=2026-09-30&role=owner`);
  rec('Bad input','Export with invalid from date -> 4xx (not 500)',req('GET','/api/invoices/export?format=xml&from=garbage'),'4xx',w.status,is4xx(w.status)?'pass':(w.status>=500?'fail':'ambiguous'));
}

// ---------- R11 PDFs ----------
async function pdf(rule, desc, url, role){ const x = await call('GET', url); const ok = x.buf.slice(0,4).toString()==='%PDF' && x.buf.length>1000; rec(rule, desc, req('GET',url), '%PDF, >1000 bytes', `${x.status} ${x.ct} ${x.buf.slice(0,5).toString()} ${x.buf.length}B`, (x.status===200&&ok)?'pass':'fail'); return x; }
await pdf('R11.1','Challan PDF',`/api/docs/challan?dispatch_id=${DA}&role=owner&actor=usr-owner`);
await pdf('R11.1','Packing list PDF',`/api/docs/packing-list?dispatch_id=${DA}&role=owner&actor=usr-owner`);
await pdf('R11.1','Invoice PDF',`/api/docs/invoice?id=${IA?.id}&role=owner&actor=usr-owner`);
await pdf('R11.1','Party statement PDF',`/api/docs/statement?party_id=${PF.id}&from=2026-04-01&to=2026-09-30&role=owner&actor=usr-owner`);
{
  const x = await call('GET',`/api/docs/invoice?id=99999999&role=owner`);
  rec('R11.1','Invoice PDF for non-existent id -> 4xx',req('GET','/api/docs/invoice?id=99999999'),'4xx',x.status,is4xx(x.status)?'pass':'fail');
  const y = await call('GET',`/api/docs/statement?party_id=${PF.id}&from=bad&to=2026-09-30&role=owner`);
  rec('Bad input','Statement with invalid from date -> not 500',req('GET',`/api/docs/statement?party_id=${PF.id}&from=bad`),'4xx',y.status,is4xx(y.status)?'pass':(y.status>=500?'fail':'ambiguous'));
}

// ---------- R12 reports ----------
{
  for (const p of ['day','week','month']) {
    const x = await call('GET',`/api/reports?period=${p}&date=${TODAY}&role=owner`);
    const s = x.json?.stock;
    const dIn = r2((s?.in??NaN) - (rep0[p]?.in??NaN)), dOut = r2((s?.out??NaN) - (rep0[p]?.out??NaN));
    rec('R12.1',`${p} report: stock in/out grew by exactly what I recorded today`,req('GET',`/api/reports?period=${p}&date=${TODAY}`),{in:myIn,out:r2(myOut)},{in:dIn,out:dOut},(near(dIn,myIn,0.01)&&near(dOut,r2(myOut),0.01))?'pass':'fail');
    if (p==='day') rec('R12.1','Day report closing = opening + in - out',req('GET',`/api/reports?period=day&date=${TODAY}`),r2(s?.opening+s?.in-s?.out),s?.closing,near(s?.closing,r2(s?.opening+s?.in-s?.out),0.01)?'pass':'fail');
  }
  const x = await call('GET',`/api/reports/export?period=day&date=${TODAY}&role=owner`);
  rec('R12.2','Report export is xlsx (PK zip)',req('GET',`/api/reports/export?period=day&date=${TODAY}`),'PK header',`${x.status} ${x.ct} ${x.buf.slice(0,2).toString()} ${x.buf.length}B`,(x.status===200&&x.buf.slice(0,2).toString()==='PK')?'pass':'fail');
  const y = await call('GET',`/api/reports?period=day&date=2026-02-31&role=owner`);
  rec('Bad input','Report with invalid date 2026-02-31 -> 4xx',req('GET','/api/reports?period=day&date=2026-02-31'),'4xx',y.status,is4xx(y.status)?'pass':(y.status>=500?'fail':'ambiguous'));
  const z = await call('GET',`/api/reports?period=day&date=nonsense&role=owner`);
  rec('Bad input','Report with non-date string -> 4xx',req('GET','/api/reports?period=day&date=nonsense'),'4xx',z.status,is4xx(z.status)?'pass':(z.status>=500?'fail':'ambiguous'));
}

// ---------- Access control ----------
const MONEY_KEY = /(^|_)(rate|rates|amount|amounts|credit|limit|outstanding|margin|cost|costs|price|taxable|cgst|sgst|igst|gst|paid|invoiced|revenue|collected|inr|purchase)(_|$)/i;
const GENERIC = /^(total|value|prev|balance)$/i;
function scan(obj, path='', hits=[]){
  if (obj && typeof obj==='object') { for (const [k,v] of Object.entries(obj)) { const p = path+'.'+k; const moneyParent = obj.unit==='inr' || Object.keys(obj).some(z=>/invoice|taxable|gst|paid/i.test(z)); if ((MONEY_KEY.test(k) || (GENERIC.test(k) && moneyParent)) && v!==null && v!==undefined && v!=='' && !(typeof v==='object' && Object.keys(v).length===0)) hits.push(p+'='+JSON.stringify(v).slice(0,40)); scan(v,p,hits);} }
  else if (typeof obj==='string' && /₹|\bRs\.?\s?\d|INR\s?\d/.test(obj)) hits.push(path+' str:'+obj.slice(0,60));
  return hits;
}
const invId = IA?.id;
const moneyEndpoints = [
  ['GET','/api/invoices?'],['GET',`/api/invoices/${invId}?`],['PATCH',`/api/invoices/${IB?.id}`,{status:'cancelled'}],['POST','/api/invoices',{dispatch_id:DA}],
  ['POST','/api/invoices',{source:'tally',invoice_no:'BBM-ACL-'+RUN,party:P('Inter'),invoice_date:TODAY,taxable_amount:1,total:1.12}],
  ['GET','/api/invoices/export?format=xml&'],['GET','/api/invoices/export?format=xlsx&'],
  ['GET',`/api/payments?party_id=${PF.id}&`],['POST','/api/payments',{party_id:PA.id,amount:1,paid_on:TODAY,mode:'cash'}],
  ['GET','/api/credit?'],['GET',`/api/credit/check?party_id=${PF.id}&amount=10&`],['GET',`/api/credit/reminder?party_id=${PF.id}&`],
  ['GET','/api/margin?by=party&'],['GET','/api/margin?by=order&'],['GET','/api/costs?'],['GET',`/api/costs/lot?lot_id=${LN}&`],['POST','/api/costs',{section:'Folding',cost_per_m:0.01,valid_from:'2026-09-02'}],
  ['GET','/api/rates?'],['POST','/api/rates',{quality:Q,rate_per_m:1,valid_from:'2026-09-27'}],['GET',`/api/orders/rate?quality=${encodeURIComponent(Q)}&party_id=${PA.id}&`],
  ['GET','/api/settings/billing?'],['PUT','/api/settings/billing',{gst_rate_pct:0,legal_name:'HACK',state_code:'27'}],
  ['GET',`/api/docs/invoice?id=${invId}&`],['GET',`/api/docs/statement?party_id=${PF.id}&`],
];
for (const [who, R] of [['supervisor',SUP],['worker',WRK]]) {
  for (const [m,u,b] of moneyEndpoints) {
    let url = u, body;
    if (m==='GET') url = u + `role=${R.role}&actor=${R.actor}`; else body = {...b, ...R};
    const x = await call(m,url,body);
    const hits = x.json ? scan(x.json) : (x.buf.slice(0,4).toString()==='%PDF'||x.buf.slice(0,2).toString()==='PK'||x.text.includes('<?xml') ? ['binary money document'] : []);
    let v = x.status===403 ? 'pass' : (x.status<300 && hits.length ? 'fail' : (x.status<300 ? 'ambiguous' : (x.status>=500?'fail':'ambiguous')));
    rec('Access', `${who} on money endpoint ${m} ${u.split('?')[0]}`, req(m,url,body), '403 (or no money values)', `${x.status} ${hits.slice(0,4).join('; ')||x.text.slice(0,80)}`, v);
  }
}
// verify no side-effects from refused writes
{
  const b = (await call('GET','/api/settings/billing?role=owner')).json?.billing;
  rec('Access','Billing settings unchanged after supervisor/worker PUT attempts',req('GET','/api/settings/billing'),{gst_rate_pct:GST,state_code:'24'},{gst_rate_pct:b?.gst_rate_pct,state_code:b?.state_code},(b?.gst_rate_pct===GST&&b?.state_code==='24')?'pass':'fail');
  const i = (await call('GET',`/api/invoices/${IB?.id}?role=owner`)).json?.invoice;
  rec('Access','Invoice B not cancelled by supervisor/worker PATCH',req('GET',`/api/invoices/${IB?.id}`),'status != cancelled',i?.status,i?.status!=='cancelled'?'pass':'fail');
  const pays = (await call('GET',`/api/payments?party_id=${PA.id}&role=owner`)).json?.payments||[];
  rec('Access','No payment recorded for Intra party by supervisor/worker',req('GET',`/api/payments?party_id=${PA.id}`),0,pays.length,pays.length===0?'pass':'fail');
}
// supervisor scan of shared endpoints
{
  const ord = await call('POST','/api/orders',{...O,party_id:PA.id,quality:Q,meters:50,rate_per_m:90,promise_date:'2026-10-02'});
  const ordId = ord.json?.order?.id;
  await call('POST','/api/inquiries',{...O,raw_text:`need 300 m ${Q} by 10th, rate?`,party_name:P('Intra')});
  await call('POST','/api/agents/run',{role:'owner'});
  const sup = [
    '/api/orders?', `/api/orders/${ordId}?`, `/api/orders/${ordId}/candidates?`, '/api/inquiries?', '/api/dispatches?', `/api/dispatches/${DA}?`,
    `/api/reports?period=day&date=${TODAY}&`, `/api/reports?period=week&date=${TODAY}&`, `/api/reports?period=month&date=${TODAY}&`,
    '/api/agents/suggestions?', '/api/parties?', '/api/parties?all=1&', '/api/inventory?', '/api/stock?', '/api/stock/flow?range=all&',
  ];
  for (const u of sup) {
    const url = u + 'role=supervisor&actor=usr-demo-sup';
    const x = await call('GET',url);
    const hits = x.json ? scan(x.json) : [];
    rec('Access/R12.4', `supervisor GET ${u.split('?')[0]}${u.includes('period')?' '+u.match(/period=(\w+)/)[1]:''} has no money fields`, req('GET',url), 'no money keys/₹', `${x.status} ${hits.slice(0,6).join('; ')}`, x.status>=500 ? 'fail' : (hits.length ? 'fail' : 'pass'));
  }
  const inqs = (await call('GET','/api/inquiries?role=supervisor&actor=usr-demo-sup')).json;
  const ch = await call('POST','/api/chat',{question:'what is the total outstanding amount?',role:'supervisor',user_id:'usr-demo-sup'});
  const hasRs = /₹|\bRs\.?\s?\d|INR/.test(ch.text) || /\d{1,3}(,\d{2,3})+/.test(ch.json?.answer||ch.text);
  rec('Access/R14.2','Supervisor chat money question returns no ₹ figure',req('POST','/api/chat',{question:'what is the total outstanding amount?',role:'supervisor'}),'no ₹ figure',`${ch.status} ${ch.text.slice(0,160)}`,(ch.status<500&&!hasRs)?'pass':'fail');
  const dsp = await call('GET',`/api/docs/challan?dispatch_id=${DA}&role=worker&actor=usr-demo-wrk`);
  rec('Access','Worker refused challan PDF (dispatches)',req('GET',`/api/docs/challan?dispatch_id=${DA}&role=worker`),403,dsp.status,dsp.status===403?'pass':'fail');
  const dsp2 = await call('GET',`/api/docs/challan?dispatch_id=${DA}&role=supervisor&actor=usr-demo-sup`);
  rec('Access','Supervisor challan PDF (money content not checked; compressed PDF)',req('GET',`/api/docs/challan?dispatch_id=${DA}&role=supervisor`),'allowed without ₹ (unspecified)',dsp2.status,'ambiguous');
  const nr = await call('GET','/api/invoices');
  rec('Access','Missing role treated as worker -> invoices 403',req('GET','/api/invoices'),403,nr.status,nr.status===403?'pass':'fail');
  const br = await call('GET','/api/invoices?role=admin');
  rec('Access','Unknown role treated as worker -> invoices 403',req('GET','/api/invoices?role=admin'),403,br.status,br.status===403?'pass':'fail');
}

fs.writeFileSync('results.json', JSON.stringify(results,null,1));
const c = results.reduce((a,r)=>(a[r.verdict]=(a[r.verdict]||0)+1,a),{});
console.log('RUN',RUN,c);
