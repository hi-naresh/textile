export const B = process.env.BASE_URL ?? 'http://localhost:3000';
export async function call(method,url,body){
  const r=await fetch(B+url,{method,headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
  const buf=Buffer.from(await r.arrayBuffer()); let json=null; const text=buf.toString('utf8');
  try{json=JSON.parse(text)}catch{}
  return {status:r.status,ct:r.headers.get('content-type'),json,text,buf};
}
const CS='0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export function gstinCheck(s14){let sum=0;for(let i=0;i<14;i++){const v=CS.indexOf(s14[i]);const w=i%2?2:1;const p=v*w;sum+=Math.floor(p/36)+p%36;}return CS[(36-sum%36)%36];}
export function gstin(state,pan,ent='1'){const s=state+pan+ent+'Z';return s+gstinCheck(s);}
export function randPan(){ for(;;){ const p=_randPan(); if(!/INR|RS/.test(p)) return p; } }
function _randPan(){const L='ABCDEFGHIJKLMNOPQRSTUVWXYZ';let p='';for(let i=0;i<5;i++)p+=L[Math.floor(Math.random()*26)];for(let i=0;i<4;i++)p+=Math.floor(Math.random()*10);p+=L[Math.floor(Math.random()*26)];return p;}
