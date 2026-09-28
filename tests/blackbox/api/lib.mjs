export const B = process.env.BASE_URL ?? 'http://localhost:3000';
export async function call(method, path, body){
  const opt={method, headers:{'content-type':'application/json'}};
  if(body!==undefined) opt.body = typeof body==='string'?body:JSON.stringify(body);
  const r=await fetch(B+path,opt); const t=await r.text(); let j; try{j=JSON.parse(t)}catch{j=t.slice(0,300)}
  return {status:r.status, body:j};
}
export const get=(p)=>call('GET',p); export const post=(p,b)=>call('POST',p,b); export const patch=(p,b)=>call('PATCH',p,b);
