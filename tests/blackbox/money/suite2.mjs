import {call,gstin,gstinCheck,randPan} from './lib.mjs';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';

const RUN = 'N' + Date.now().toString(36).toUpperCase().slice(-4);
const O = {role:'owner',actor:'usr-owner'};
const SUPQ = 'role=supervisor&actor=usr-demo-sup';
const results = []; let n = 0;
function rec(rule, description, request, expected, actual, verdict){
  const id = 'N' + String(++n).padStart(3,'0');
  results.push({id, spec_rule: rule, description, request, expected, actual, verdict});
  console.log(id, verdict.toUpperCase().padEnd(9), rule, '|', description, verdict!=='pass' ? ('| exp: '+JSON.stringify(expected)+' | act: '+JSON.stringify(actual).slice(0,260)) : '');
}
const r2 = x => Math.round(x*100)/100;
const near = (a,b,tol=0.005) => typeof a==='number' && Math.abs(a-b) <= tol + 1e-9;
const is4xx = s => s>=400 && s<500;
const req = (m,u,b) => ({method:m,url:u,body:b});
const TODAY = '2026-09-28';
const P = s => `BBM-${s}-${RUN}`;
const BAD_DATES = ['2026-02-30','2026-04-31','2027-02-29'];

await call('PUT','/api/settings/billing',{...O,legal_name:'BBM Firm',gstin:gstin('24','AABCB1111B'),state_code:'24',address:'x',city:'Surat',phone:'9999999999',gst_rate_pct:12,hsn_code:'5407',invoice_prefix:'BBM',bank_name:'b',bank_account:'123456789012',bank_ifsc:'HDFC0000001',low_stock_m:100,ageing_days:60});
async function party(name, extra){ const x = await call('POST','/api/parties',{...O,name,...extra}); if (x.status>=300) console.log('party fail',name,x.text); return x.json?.party; }

// ================= A. GSTIN structure =================
{
  const mk = (s14) => s14 + gstinCheck(s14);
  const PAN = randPan(); const L5=PAN.slice(0,5), D4=PAN.slice(5,9), LL=PAN[9]; // fresh PAN per run (setup fix: duplicate GSTINs are refused across runs)
  const cases = [
    ['valid: 24 + PAN + 1 Z chk', mk('24'+PAN+'1Z'), 'ok'],
    ['state code not 2 digits (2A)', mk('2A'+PAN+'1Z'), 'bad'],
    ['PAN 5th char digit', mk('24'+L5.slice(0,4)+'1'+D4+LL+'1Z'), 'bad'],
    ['PAN digit block has a letter', mk('24'+L5+D4.slice(0,2)+'X'+D4[3]+LL+'1Z'), 'bad'],
    ['PAN 10th char digit (last must be letter)', mk('24'+L5+D4+'5'+'1Z'), 'bad'],
    ['entity char not alphanumeric (-)', '24'+PAN+'-Z' + 'A', 'bad'],
    ['14th char Y instead of Z', mk('24'+PAN+'1Y'), 'bad'],
    ['wrong check char', (s=>s.slice(0,14)+(s[14]==='0'?'1':'0'))(mk('24'+PAN+'1Z')), 'bad'],
    ['16 characters', mk('24'+PAN+'2Z')+'A', 'bad'],
    ['lower-case otherwise valid (fresh entity 3)', mk('24'+PAN+'3Z').toLowerCase(), 'amb'],
    ['state code 00', mk('00'+PAN+'1Z'), 'amb'],
  ];
  let i = 0;
  for (const [desc, g, want] of cases) {
    const b = {...O, name:P('G'+(++i)), gstin:g};
    const x = await call('POST','/api/parties',b);
    const v = want==='ok' ? (x.status<300?'pass':'fail') : want==='bad' ? (is4xx(x.status)&&x.json?.error?'pass':'fail') : (x.status>=500?'fail':'ambiguous');
    rec('R2.2','GSTIN '+desc, req('POST','/api/parties',b), want==='ok'?'2xx':want==='bad'?'4xx':'unspecified', `${x.status} ${x.text.slice(0,120)}`, v);
  }
}

// ================= setup stock/rates =================
const QF = `BBM-QF-${RUN}`;
await call('POST','/api/rates',{...O,quality:QF,rate_per_m:100,valid_from:'2026-01-01'});
const LF = `BBM-LF-${RUN}`;
await call('POST','/api/stock',{...O,direction:'IN',lot_id:LF,quality:QF,design:'D',grey_meters:2000,finished_meters:2000,mill_name:'BBM Mill',purchase_rate:40,moved_by:'usr-owner'});
async function invoice(pname, meters, date){ const d = await call('POST','/api/dispatches',{...O,party:pname,lines:[{lot_id:LF,meters}],transporter:'t'}); const b={...O,dispatch_id:d.json?.dispatch?.id}; if (date) b.invoice_date=date; const x = await call('POST','/api/invoices',b); if (x.status>=300) console.log('inv fail',x.text); return x.json?.invoice; }

// ================= B. impossible dates =================
{
  const DP = await party(P('Dates'),{state_code:'24'});
  await call('POST','/api/rates',{...O,quality:QF,party_id:DP.id,rate_per_m:100,valid_from:'2024-01-01'}); // setup fix: a rate must exist on back-dated invoice dates
  const d1 = await call('POST','/api/dispatches',{...O,party:P('Dates'),lines:[{lot_id:LF,meters:1}]});
  const ord = await call('POST','/api/orders',{...O,party_id:DP.id,quality:QF,meters:10,rate_per_m:100,promise_date:'2026-10-15'});
  const inq = await call('POST','/api/inquiries',{...O,raw_text:`need 50 m ${QF}`});
  const inputs = [
    ['rates.valid_from', d=>['POST','/api/rates',{...O,quality:QF,party_id:DP.id,rate_per_m:101,valid_from:d}], '2028-02-29'],
    ['costs.valid_from', d=>['POST','/api/costs',{...O,section:'Folding',cost_per_m:1.2,valid_from:d}], '2028-02-29'],
    ['orders.promise_date', d=>['POST','/api/orders',{...O,party_id:DP.id,quality:QF,meters:5,rate_per_m:100,promise_date:d}], '2028-02-29'],
    ['PATCH orders.promise_date', d=>['PATCH',`/api/orders/${ord.json?.order?.id}`,{...O,promise_date:d}], '2028-02-29'],
    ['PATCH inquiries.needed_by', d=>['PATCH',`/api/inquiries/${inq.json?.inquiry?.id}`,{...O,needed_by:d}], '2028-02-29'],
    ['invoice (from dispatch).invoice_date', d=>['POST','/api/invoices',{...O,dispatch_id:d1.json?.dispatch?.id,invoice_date:d}], '2024-02-29'],
    ['tally invoice_date', d=>['POST','/api/invoices',{...O,source:'tally',invoice_no:P('T')+d,party:P('Dates'),invoice_date:d,taxable_amount:100,total:112}], '2024-02-29'],
    ['tally due_date', d=>['POST','/api/invoices',{...O,source:'tally',invoice_no:P('TD')+d,party:P('Dates'),invoice_date:'2026-09-01',due_date:d,taxable_amount:100,total:112}], '2028-02-29'],
    ['payments.paid_on', d=>['POST','/api/payments',{...O,party_id:DP.id,amount:1,paid_on:d,mode:'cash',reference:P('R')+d}], '2024-02-29'],
    ['reports.date', d=>['GET',`/api/reports?period=day&date=${d}&role=owner`], '2024-02-29'],
    ['reports/export.date', d=>['GET',`/api/reports/export?period=day&date=${d}&role=owner`], '2024-02-29'],
    ['invoices/export from', d=>['GET',`/api/invoices/export?format=xml&from=${d}&to=2026-09-30&role=owner`], '2024-02-29'],
    ['invoices/export to', d=>['GET',`/api/invoices/export?format=xlsx&from=2026-04-01&to=${d}&role=owner`], '2028-02-29'],
    ['invoices list from', d=>['GET',`/api/invoices?from=${d}&role=owner`], '2024-02-29'],
    ['docs/statement from', d=>['GET',`/api/docs/statement?party_id=${DP.id}&from=${d}&to=2026-09-30&role=owner`], '2024-02-29'],
    ['docs/statement to', d=>['GET',`/api/docs/statement?party_id=${DP.id}&from=2026-04-01&to=${d}&role=owner`], '2028-02-29'],
  ];
  for (const [name, f, leap] of inputs) {
    const sts = [];
    for (const d of BAD_DATES) { const [m,u,b] = f(d); const x = await call(m,u,b); sts.push(`${d}:${x.status}`); }
    const allBad = sts.every(s=>is4xx(+s.split(':')[1]));
    rec('Bad input', `${name}: Feb 30 / Apr 31 / 2027-02-29 refused`, req(...f('<bad>')), 'all 4xx', sts.join(' '), allBad?'pass':'fail');
    const [m,u,b] = f(leap); const x = await call(m,u,b);
    rec('Bad input', `${name}: leap day ${leap} accepted`, req(m,u,b), '2xx', `${x.status} ${x.status>=300?x.text.slice(0,100):''}`, x.status<300?'pass':'fail');
  }
}

// ================= C. shortage cost =================
{
  const QS = `BBM-QS-${RUN}`;
  const lots = [[`BBM-S0-${RUN}`,200,200],[`BBM-S1-${RUN}`,250,200],[`BBM-S2-${RUN}`,300,200]];
  for (const [l,g,f] of lots) await call('POST','/api/stock',{...O,direction:'IN',lot_id:l,quality:QS,design:'D',grey_meters:g,finished_meters:f,mill_name:'BBM Mill',purchase_rate:40,moved_by:'usr-owner'});
  const c = [];
  for (const [l] of lots) c.push((await call('GET',`/api/costs/lot?lot_id=${l}&role=owner`)).json?.cost);
  const [c0,c1,c2] = c;
  const p1 = c1?.process_total ?? 0;
  rec('R10.1','No-shortage lot cost = purchase 40 + process_total',req('GET',`/api/costs/lot?lot_id=${lots[0][0]}`),40+(c0?.process_total??0),c0?.total,near(c0?.total,40+(c0?.process_total??0),0.01)?'pass':'fail');
  rec('R10.1','25% shortage lot (250 grey -> 200 finished) cost > purchase + process',req('GET',`/api/costs/lot?lot_id=${lots[1][0]}`),`> ${40+p1}`,c1,(c1?.total>40+p1)?'pass':'fail');
  rec('R10.1','Larger shortage (300->200) costs more than smaller (250->200)',req('GET',`/api/costs/lot?lot_id=${lots[2][0]}`),`> ${c1?.total}`,c2?.total,(c2?.total>c1?.total)?'pass':'fail');
  rec('R10.1','Exact shortage-lot cost 40*250/200 + process (combination of process with shortage unspecified)',req('GET',`/api/costs/lot?lot_id=${lots[1][0]}`),50+p1,c1?.total,'ambiguous');
  rec('R10.1','Process cost combined with purchase for a lot (no way to attach job cards via documented API)',req('GET',`/api/costs/lot?lot_id=${lots[1][0]}`),'purchase + applicable process',{process:c1?.process,process_total:c1?.process_total},'ambiguous');
}

// ================= D. credit check matrix =================
{
  const NL = await party(P('CrNo'),{state_code:'24',credit_limit:10000,credit_days:30});
  await invoice(P('CrNo'),10);          // 1120, not overdue
  const WO = await party(P('CrOd'),{state_code:'24',credit_limit:10000,credit_days:10});
  await invoice(P('CrOd'),10,'2026-06-01');  // 1120, overdue
  const NO = await party(P('CrNoLim'),{state_code:'24',credit_days:10});
  await invoice(P('CrNoLim'),10,'2026-06-01');
  const cases = [
    [NL,'no overdue',5000,true],[NL,'no overdue',8880,true],[NL,'no overdue',8881,false],
    [WO,'with overdue',5000,true],[WO,'with overdue',8880,true],[WO,'with overdue',8881,false],
    [NO,'no limit + overdue',9999999,true],
  ];
  for (const [p,label,amt,okExp] of cases) {
    const u = `/api/credit/check?party_id=${p.id}&amount=${amt}&role=owner`;
    const x = await call('GET',u);
    const got = x.json?.ok;
    const v = okExp ? (got===true?'pass':'fail') : ((got===false||x.json?.warn)?'pass':'fail');
    rec('R9.4',`Credit check ${label}: 1120 + ${amt} vs ${p.credit_limit??'no limit'} -> ${okExp?'ok':'not ok'}`,req('GET',u),okExp?'ok true':'ok false/warn',x.json,v);
  }
}

// ================= E/F. part-paid, payoff, overpayment, status filters =================
{
  const PP = await party(P('Part'),{state_code:'24',credit_days:30});
  const I1 = await invoice(P('Part'),10,'2026-08-01');
  const I2 = await invoice(P('Part'),10,'2026-09-01');
  let k = 0;
  const pay = async amt => call('POST','/api/payments',{...O,party_id:PP.id,amount:amt,paid_on:TODAY,mode:'bank',reference:P('PAY')+(++k)});
  const get = async () => { const l=(await call('GET',`/api/invoices?party_id=${PP.id}&role=owner`)).json?.invoices||[]; return [l.find(i=>i.id===I1?.id), l.find(i=>i.id===I2?.id)]; };
  const isPart = s => /part/i.test(s||''), isUnpaid = s => s==='unpaid'||s==='open', isPaid = s => s==='paid';
  let x = await pay(100); let [a,b] = await get();
  rec('R9.2','Pay 100: oldest invoice part-paid (bal 1020), newer unpaid',req('POST','/api/payments',{amount:100}),{I1:['part-paid',1020],I2:['unpaid',1120]},{I1:[a?.status,a?.balance],I2:[b?.status,b?.balance]},(isPart(a?.status)&&near(a?.balance,1020)&&isUnpaid(b?.status)&&near(b?.balance,1120))?'pass':'fail');
  // status filter part-paid
  let f = await call('GET',`/api/invoices?party_id=${PP.id}&status=part-paid&role=owner`);
  if (is4xx(f.status)) { const m = (f.json?.error||'').match(/\b(part[\w-]*)/i); if (m) f = await call('GET',`/api/invoices?party_id=${PP.id}&status=${m[1]}&role=owner`); }
  let ids = (f.json?.invoices||[]).map(i=>i.id);
  rec('R9.2','Status filter part-paid returns exactly the part-paid invoice',req('GET',`/api/invoices?party_id=${PP.id}&status=part-paid`),[I1?.id],`${f.status} ${JSON.stringify(ids)}`,(JSON.stringify(ids)===JSON.stringify([I1?.id]))?'pass':'fail');
  x = await pay(1020); [a,b] = await get();
  rec('R9.2','Pay exactly the remaining 1020: I1 paid (bal 0), I2 still unpaid (not part-paid)',req('POST','/api/payments',{amount:1020}),{I1:['paid',0],I2:['unpaid',1120]},{I1:[a?.status,a?.balance],I2:[b?.status,b?.balance]},(isPaid(a?.status)&&near(a?.balance,0)&&isUnpaid(b?.status)&&near(b?.balance,1120))?'pass':'fail');
  x = await pay(1119.99); [a,b] = await get();
  rec('R9.2','Pay 1119.99: I2 part-paid with balance 0.01',req('POST','/api/payments',{amount:1119.99}),['part-paid',0.01],[b?.status,b?.balance],(isPart(b?.status)&&near(b?.balance,0.01))?'pass':'fail');
  x = await pay(0.01); [a,b] = await get();
  const cr = async()=> (await call('GET',`/api/credit?party_id=${PP.id}&role=owner`)).json?.parties?.find(p=>p.party_id===PP.id);
  let c = await cr();
  rec('R9.2/9.3','Pay final 0.01: both paid, outstanding 0',req('POST','/api/payments',{amount:0.01}),{s:['paid','paid'],outstanding:0},{s:[a?.status,b?.status],outstanding:c?.outstanding},(isPaid(a?.status)&&isPaid(b?.status)&&near(c?.outstanding??0,0))?'pass':'fail');
  f = await call('GET',`/api/invoices?party_id=${PP.id}&status=paid&role=owner`);
  ids = (f.json?.invoices||[]).map(i=>i.id).sort((p,q)=>p-q);
  rec('R9.2','Status filter paid returns both invoices',req('GET',`/api/invoices?party_id=${PP.id}&status=paid`),[I1?.id,I2?.id].sort((p,q)=>p-q),ids,JSON.stringify(ids)===JSON.stringify([I1?.id,I2?.id].sort((p,q)=>p-q))?'pass':'fail');
  x = await pay(500); [a,b] = await get(); c = await cr();
  rec('R9.1','Overpayment 500 with nothing due: no 500 error; invoices stay paid with balance 0',req('POST','/api/payments',{amount:500}),'2xx or 4xx; balances 0',{status:x.status,bal:[a?.balance,b?.balance],st:[a?.status,b?.status]},(x.status<500&&near(a?.balance,0)&&near(b?.balance,0)&&isPaid(a?.status)&&isPaid(b?.status))?'pass':'fail');
  rec('R9.3','Outstanding after overpayment (invoiced 2240 - payments 2740 = -500 per R9.3 formula; advance handling unspecified)',req('GET',`/api/credit?party_id=${PP.id}`),-500,{outstanding:c?.outstanding,advance:c?.advance},x.status<300 ? (near(c?.outstanding,-500)?'pass':'ambiguous') : 'ambiguous');
  const I3 = await invoice(P('Part'),10);
  c = await cr();
  rec('R9.2','New invoice after 500 overpayment: outstanding = 2240+1120 - 2740 = 620 (if overpayment was accepted)',req('GET',`/api/credit?party_id=${PP.id}`),620,{outstanding:c?.outstanding,status:(await call('GET',`/api/invoices/${I3?.id}?role=owner`)).json?.invoice?.status},x.status<300 ? (near(c?.outstanding,620)?'pass':'fail') : 'ambiguous');
  // cancelled / overdue filters
  const CX = await party(P('Filt'),{state_code:'24',credit_days:10});
  const J1 = await invoice(P('Filt'),5,'2026-06-01');
  const J2 = await invoice(P('Filt'),5);
  await call('PATCH',`/api/invoices/${J2?.id}`,{...O,status:'cancelled'});
  f = await call('GET',`/api/invoices?party_id=${CX.id}&status=cancelled&role=owner`);
  ids = (f.json?.invoices||[]).map(i=>i.id);
  rec('R8.1','Status filter cancelled returns only the cancelled invoice',req('GET',`/api/invoices?party_id=${CX.id}&status=cancelled`),[J2?.id],ids,JSON.stringify(ids)===JSON.stringify([J2?.id])?'pass':'fail');
  f = await call('GET',`/api/invoices?party_id=${CX.id}&status=overdue&role=owner`);
  ids = (f.json?.invoices||[]).map(i=>i.id);
  rec('R9.3','Status filter overdue returns only the past-due invoice',req('GET',`/api/invoices?party_id=${CX.id}&status=overdue`),[J1?.id],`${f.status} ${JSON.stringify(ids)}`,JSON.stringify(ids)===JSON.stringify([J1?.id])?'pass':'fail');
  f = await call('GET',`/api/invoices?status=bogus&role=owner`);
  rec('Bad input','Unknown status filter -> 4xx',req('GET','/api/invoices?status=bogus'),'4xx',f.status,is4xx(f.status)?'pass':'fail');
  // invalid from/to
  for (const u of [`/api/invoices/export?format=xml&from=garbage&to=2026-09-30&role=owner`,`/api/invoices/export?format=xlsx&from=2026-04-01&to=31-12-2026x&role=owner`,`/api/docs/statement?party_id=${CX.id}&from=abc&to=2026-09-30&role=owner`,`/api/docs/statement?party_id=${CX.id}&from=2026-04-01&to=zzz&role=owner`]) {
    const y = await call('GET',u);
    rec('Bad input','Invalid from/to -> 4xx',req('GET',u),'4xx',`${y.status} ${y.text.slice(0,80)}`,is4xx(y.status)?'pass':'fail');
  }
  const y = await call('GET',`/api/invoices/export?format=xml&from=2026-09-30&to=2026-04-01&role=owner`);
  rec('Bad input','Export with from > to',req('GET','/api/invoices/export?format=xml&from=2026-09-30&to=2026-04-01'),'4xx or empty (unspecified)',y.status,y.status>=500?'fail':'ambiguous');
}

// ================= H. supervisor scan everywhere =================
{
  const MONEY_KEY = /(^|_)(rate|rates|amount|amounts|credit|limit|outstanding|margin|cost|costs|price|taxable|cgst|sgst|igst|gst|paid|invoiced|revenue|collected|inr|purchase)(_|$)/i;
  const GENERIC = /^(total|value|prev|balance)$/i;
  function scan(obj, path='', hits=[]){
    if (obj && typeof obj==='object') { const moneyParent = obj.unit==='inr' || Object.keys(obj).some(z=>/invoice|taxable|gst|paid/i.test(z));
      for (const [k,v] of Object.entries(obj)) { const p=path+'.'+k; if ((MONEY_KEY.test(k)||(GENERIC.test(k)&&moneyParent)) && v!==null && v!==undefined && v!=='' && !(typeof v==='object'&&Object.keys(v).length===0)) hits.push(p+'='+JSON.stringify(v).slice(0,40)); scan(v,p,hits);} }
    else if (typeof obj==='string' && /₹|\bRs\.?\s?\d|INR\s?\d/.test(obj)) hits.push(path+' str:'+obj.slice(0,60));
    return hits;
  }
  const SP = await party(P('Sup'),{state_code:'24',credit_limit:5000});
  const ordO = await call('POST','/api/orders',{...O,party_id:SP.id,quality:QF,meters:20,rate_per_m:100,promise_date:'2026-10-01'});
  const oid = ordO.json?.order?.id;
  const endpoints = ['/api/orders?',`/api/orders/${oid}?`,`/api/orders/${oid}/candidates?`,'/api/inquiries?','/api/dispatches?','/api/dispatches?days=30&',
    '/api/parties?',`/api/parties?all=1&q=BBM&`,'/api/stock?','/api/stock/flow?range=day&','/api/stock/flow?range=all&','/api/inventory?','/api/status?','/api/workers?',
    `/api/reports?period=day&date=${TODAY}&`,`/api/reports?period=week&date=${TODAY}&`,`/api/reports?period=month&date=${TODAY}&`,'/api/agents/suggestions?'];
  for (const u of endpoints) {
    const url = u + SUPQ; const x = await call('GET',url); const hits = x.json ? scan(x.json) : [];
    rec('Access/R12.4',`supervisor GET ${u.replace(/\?$/,'')} contains no money`,req('GET',url),'no money keys/₹',`${x.status} ${hits.slice(0,5).join('; ')}`,(x.status<500&&hits.length===0)?'pass':'fail');
  }
  // report export xlsx content
  {
    const x = await call('GET',`/api/reports/export?period=month&date=${TODAY}&${SUPQ}`);
    let txt=''; if (x.buf.slice(0,2).toString()==='PK') { fs.writeFileSync('sup_report.xlsx',x.buf); try { txt = execFileSync('python3',['-c','import zipfile,sys,re;z=zipfile.ZipFile(sys.argv[1]);print("\\n".join(re.findall(r"<t[^>]*>([^<]*)</t>",z.read("xl/sharedStrings.xml").decode())))','sup_report.xlsx']).toString(); } catch{} }
    const bad = /₹/.test(txt) || txt.split('\n').some(l=>/^(Invoiced|Collected|Outstanding|Margin|Revenue|Amount|Rate|Cost|Value \(₹\))/i.test(l.trim()));
    rec('R12.4','supervisor report export (xlsx) has no ₹ / invoiced / collected / margin',req('GET',`/api/reports/export?period=month&date=${TODAY}&${SUPQ}`),'no money content',`${x.status} moneyWords=${bad}`,(x.status===403||(x.status===200&&!bad))?'pass':'fail');
  }
  // supervisor writes: responses scanned
  {
    const b = {role:'supervisor',actor:'usr-demo-sup',raw_text:`need 40 m ${QF} by 5th rate?`,party_name:P('Sup')};
    const x = await call('POST','/api/inquiries',b); const hits = x.json?scan(x.json):[];
    rec('R4.2/Access','supervisor POST /api/inquiries response has no rate/₹',req('POST','/api/inquiries',b),'2xx, no money',`${x.status} ${hits.join('; ')}`,(x.status<300&&hits.length===0)?'pass':'fail');
    const iid = x.json?.inquiry?.id;
    if (iid) { const g = await call('GET',`/api/inquiries/${iid}?${SUPQ}`); const h=g.json?scan(g.json):[]; rec('R4.2/Access','supervisor GET /api/inquiries/<id> has no rate/₹',req('GET',`/api/inquiries/${iid}?${SUPQ}`),'no money',`${g.status} ${h.join('; ')}`,(g.status<500&&h.length===0)?'pass':'fail'); }
    const db = {role:'supervisor',actor:'usr-demo-sup',party:P('Sup'),order_id:oid,lines:[{lot_id:LF,meters:5}],transporter:'t',create_invoice:true};
    const d = await call('POST','/api/dispatches',db); const dh = d.json?scan(d.json):[];
    const invs = (await call('GET',`/api/invoices?party_id=${SP.id}&role=owner`)).json?.invoices||[];
    rec('Access','supervisor dispatch with create_invoice=true: response has no money and no invoice is created',req('POST','/api/dispatches',db),'dispatch ok or 403; 0 invoices; no money',`${d.status} invoices=${invs.length} ${dh.join('; ')}`,(d.status<500&&invs.length===0&&dh.length===0)?'pass':'fail');
    const pb = {role:'supervisor',actor:'usr-demo-sup',meters:25};
    const po = await call('PATCH',`/api/orders/${oid}`,pb); const ph = po.json?scan(po.json):[];
    rec('Access','supervisor PATCH /api/orders/<id> response has no rate',req('PATCH',`/api/orders/${oid}`,pb),'no money',`${po.status} ${ph.join('; ')}`,(po.status<500&&ph.length===0)?'pass':'fail');
    const pr = await call('PATCH',`/api/orders/${oid}`,{role:'supervisor',actor:'usr-demo-sup',rate_per_m:1});
    const after = (await call('GET',`/api/orders/${oid}?role=owner`)).json?.order;
    rec('Access','supervisor cannot change an order rate (money)',req('PATCH',`/api/orders/${oid}`,{rate_per_m:1,role:'supervisor'}),'rate stays 100',`${pr.status} rate=${after?.rate_per_m}`,Number(after?.rate_per_m)===100?'pass':'fail');
    for (const q of ['what is the rate of '+QF+'?','how much does '+P('Sup')+' owe?','total sales this month?']) {
      const c = await call('POST','/api/chat',{question:q,role:'supervisor',user_id:'usr-demo-sup'});
      const has = /₹|\bRs\.?\s?\d|INR\s?\d/.test(c.text) || /\b1,120\b|\b100(\.00)?\s*\/\s*m/.test(c.json?.answer||'');
      rec('R14.2','supervisor chat money question has no ₹ figure',req('POST','/api/chat',{question:q,role:'supervisor'}),'no ₹',`${c.status} ${(c.json?.answer||c.text).slice(0,120)}`,(c.status<500&&!has)?'pass':'fail');
    }
  }
}

fs.writeFileSync('results_suite2.json', JSON.stringify(results,null,1));
const all = [...JSON.parse(fs.readFileSync('results_suite1.json','utf8')), ...results];
fs.writeFileSync('results.json', JSON.stringify(all,null,1));
const cnt = a => a.reduce((z,r)=>(z[r.verdict]=(z[r.verdict]||0)+1,z),{});
console.log('RUN',RUN,'suite2',cnt(results),'all',cnt(all), all.length);
