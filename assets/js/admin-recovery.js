(()=>{
  "use strict";
  const state={authenticated:false,generation:0,request:null,rows:new Map(),mutations:new Map(),timer:null,lastSuccess:0};
  const $=selector=>document.querySelector(selector);
  const validPhone=value=>typeof value==="string"&&/^62\d{7,13}$/.test(value);
  const validChallenge=value=>typeof value==="string"&&/^[a-f0-9]{48}$/.test(value);
  const expired=item=>Date.parse(item.expiresAt)<=Date.now();
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init);else init();
  function init(){
    if(!$("#recovery-requests"))return;
    $("#refresh-recovery")?.addEventListener("click",()=>loadRequests(false));
    document.addEventListener("dapoer:admin-session",event=>setAuthenticated(!!event.detail?.authenticated));
    document.addEventListener("dapoer:admin-session-expired",()=>setAuthenticated(false));
    window.DapoerAdminSession?.subscribe(()=>setAuthenticated(false));
    document.addEventListener("visibilitychange",()=>{
      if(document.hidden){clearPrivateLinks();return}
      if(state.authenticated)loadRequests(true);
    });
    if(window.DapoerAdminAuthenticated)setAuthenticated(true);
  }
  function clearPrivateLinks(){state.rows.forEach(row=>{row.link.hidden=true;row.link.removeAttribute("href");row.url=null;updateRow(row)})}
  function setAuthenticated(value){
    if(value===state.authenticated)return;
    state.authenticated=value;state.generation++;
    state.request?.controller.abort();state.request=null;
    if(state.timer)clearInterval(state.timer);state.timer=null;
    if(!value){
      state.mutations.forEach(item=>item.controller?.abort());state.mutations.clear();clearPrivateLinks();state.rows.clear();
      $("#recovery-requests")?.replaceChildren();caption("Permintaan dimuat setelah login.");return;
    }
    loadRequests(true);state.timer=setInterval(()=>{if(!document.hidden)loadRequests(true)},10000);
  }
  function caption(message){const node=$("#recovery-caption");if(node)node.textContent=message}
  function expireSession(){
    setAuthenticated(false);window.DapoerAdminSession?.notifyLogout("expired");
    if(typeof document.dispatchEvent==="function"&&typeof CustomEvent==="function")document.dispatchEvent(new CustomEvent("dapoer:admin-session-expired"));
  }
  async function boundedRequest(url,options,operation,timeoutMs){
    let timeout;
    try{return await Promise.race([
      (async()=>{const res=await fetch(url,{...options,cache:"no-store",signal:operation.controller.signal});if(operation.generation!==state.generation||!state.authenticated)return null;if(res.status===401){expireSession();return null}return {res,data:await res.json()}})(),
      new Promise((_,reject)=>{timeout=setTimeout(()=>{operation.controller?.abort();reject(new Error("Koneksi melewati batas waktu."))},timeoutMs)})
    ])}finally{clearTimeout(timeout)}
  }
  function validateRequest(item){
    return item&&validChallenge(item.challengeId)&&validPhone(item.phone)&&typeof item.maskedPhone==="string"&&["awaiting-admin","issued"].includes(item.status)&&Number.isSafeInteger(item.orderCount)&&item.orderCount>0&&Number.isFinite(Date.parse(item.createdAt))&&Number.isFinite(Date.parse(item.expiresAt))&&Date.parse(item.expiresAt)>Date.parse(item.createdAt);
  }
  async function loadRequests(silent=false){
    if(!state.authenticated||state.request||document.hidden)return;
    const request={generation:state.generation,controller:new AbortController()};state.request=request;
    const refresh=$("#refresh-recovery");refresh.disabled=true;
    if(!silent)caption("Memuat permintaan pemulihan…");
    try{
      const result=await boundedRequest("/api/admin/orders?view=recovery-requests",{headers:{Accept:"application/json"}},request,12000);
      if(!result||state.request!==request||request.generation!==state.generation)return;
      const {res,data}=result;
      if(!res.ok)throw new Error(data.error||"Permintaan belum dapat dimuat.");
      if(!Array.isArray(data.requests)||data.requests.some(item=>!validateRequest(item)))throw new Error("Data pemulihan belum lengkap. Coba refresh lagi.");
      const requests=data.requests.filter(item=>!expired(item)),visible=new Set(requests.map(item=>item.challengeId));
      const root=$("#recovery-requests");
      state.rows.forEach((row,id)=>{if(!visible.has(id)){row.link.removeAttribute("href");row.root.remove();state.rows.delete(id);state.mutations.get(id)?.controller?.abort();state.mutations.delete(id)}});
      requests.forEach((item,index)=>{
        let row=state.rows.get(item.challengeId);if(!row){row=makeRow(item);state.rows.set(item.challengeId,row)}else row.item=item;
        updateRow(row);if(root.children[index]!==row.root)root.insertBefore(row.root,root.children[index]||null);
      });
      state.lastSuccess=Date.now();caption(requests.length?`${requests.length} permintaan aktif · kode berlaku 10 menit sejak diminta customer. Customer tidak perlu memesan ulang.`:"Belum ada permintaan pemulihan aktif.");
    }catch(error){
      if(state.request!==request||request.generation!==state.generation)return;
      state.rows.forEach(updateRow);
      caption(state.rows.size?"Pembaruan terputus. Data terakhir masih ditampilkan; periksa masa berlaku sebelum mengirim kode.":"Permintaan belum dapat dimuat. Tekan Refresh permintaan untuk mencoba lagi.");
    }finally{if(state.request===request){state.request=null;refresh.disabled=false}}
  }
  function makeRow(item){
    const root=document.createElement("article");root.className="recovery-request";
    const copy=document.createElement("div"),title=document.createElement("strong"),details=document.createElement("p");copy.append(title,details);
    const actions=document.createElement("div");actions.className="recovery-request-actions";
    const button=document.createElement("button");button.type="button";button.addEventListener("click",()=>prepareWhatsApp(item.challengeId));
    const link=document.createElement("a");link.className="recovery-whatsapp-link";link.target="_blank";link.rel="noopener noreferrer";link.referrerPolicy="no-referrer";link.textContent="Buka WhatsApp & kirim kode";link.hidden=true;
    const message=document.createElement("p");message.className="recovery-request-message";message.setAttribute("role","status");message.setAttribute("aria-live","polite");
    actions.append(button,link);root.append(copy,actions,message);return {root,title,details,button,link,message,item,url:null,notice:""};
  }
  function updateRow(row){
    const item=row.item,mutation=state.mutations.get(item.challengeId),ended=expired(item);
    if(ended||document.hidden){row.url=null;row.link.removeAttribute("href")}
    row.title.textContent=`WhatsApp ${item.maskedPhone}`;
    row.details.textContent=`${item.orderCount} pesanan dapat dipulihkan · berlaku sampai ${new Date(item.expiresAt).toLocaleTimeString("id-ID",{timeZone:"Asia/Jakarta",hour:"2-digit",minute:"2-digit"})} WIB`;
    row.button.disabled=ended||!!mutation?.controller;
    row.button.textContent=mutation?.controller?"Menyiapkan kode…":mutation?.uncertain?"Periksa kode yang sama":row.url?"Siapkan ulang tautan":"Siapkan kode WhatsApp";
    row.button.setAttribute("aria-label",`Siapkan kode WhatsApp untuk ${item.maskedPhone}`);
    row.link.hidden=!row.url||ended||document.hidden;
    row.message.textContent=ended?"Kode kedaluwarsa. Minta customer mengajukan pemulihan lagi.":mutation?.controller?"Menyiapkan tautan untuk nomor pada pesanan…":mutation?.uncertain?"Hasil belum terkonfirmasi. Periksa kode yang sama tanpa membuat permintaan baru.":row.url?"Kode sudah disiapkan. Buka WhatsApp lalu tekan Kirim; kode belum otomatis terkirim.":row.notice||"Siapkan kode, lalu kirim ke nomor WhatsApp yang tercatat pada pesanan.";
    row.message.classList.toggle("error",ended||!!mutation?.uncertain);
  }
  function safeWhatsApp(value,phone){
    if(typeof value!=="string"||!validPhone(phone))return null;
    try{
      const url=new URL(value);if(url.protocol!=="https:"||url.username||url.password||url.port||url.hash)return null;
      const shortLink=url.hostname==="wa.me"&&/^\/62\d{7,13}\/?$/.test(url.pathname);
      const apiLink=url.hostname==="api.whatsapp.com"&&url.pathname==="/send";
      const recipient=shortLink?url.pathname.replaceAll("/",""):apiLink&&url.searchParams.getAll("phone").length===1?url.searchParams.get("phone"):null;
      if(recipient!==phone||url.searchParams.getAll("text").length!==1||!url.searchParams.get("text"))return null;
      if(Array.from(url.searchParams.keys()).some(key=>key!=="text"&&(!apiLink||key!=="phone")))return null;
      return url.href;
    }catch{return null}
  }
  async function prepareWhatsApp(id){
    const row=state.rows.get(id);if(!state.authenticated||!row||expired(row.item)||document.hidden)return;
    let mutation=state.mutations.get(id);if(mutation?.controller)return;
    if(!mutation){
      if(!globalThis.crypto?.randomUUID){row.notice="Refresh halaman sebelum menyiapkan kode.";updateRow(row);return}
      mutation={generation:state.generation,body:{action:"send-recovery-code",challengeId:id,requestId:crypto.randomUUID()}};state.mutations.set(id,mutation);
    }
    mutation.controller=new AbortController();mutation.uncertain=false;row.url=null;row.link.removeAttribute("href");updateRow(row);
    try{
      const result=await boundedRequest("/api/admin/orders",{method:"POST",headers:{"Content-Type":"application/json",Accept:"application/json"},body:JSON.stringify(mutation.body)},mutation,30000);
      if(!result||mutation.generation!==state.generation||state.rows.get(id)!==row)return;
      const {res,data}=result;
      if(!res.ok){
        if(res.status>=500)throw new Error("Server belum mengonfirmasi kode.");
        state.mutations.delete(id);row.notice=["RECOVERY_EXPIRED","RECOVERY_CONSUMED","RECOVERY_NOT_FOUND"].includes(data.code)?"Permintaan sudah tidak aktif. Minta customer mengajukan pemulihan lagi.":data.error||"Kode belum dapat disiapkan. Refresh permintaan dan coba lagi.";
        await loadRequests(true);return;
      }
      const url=safeWhatsApp(data.whatsappUrl,row.item.phone);
      if(data.challengeId!==id||data.status!=="issued"||!Number.isFinite(Date.parse(data.expiresAt))||Date.parse(data.expiresAt)!==Date.parse(row.item.expiresAt)||!url)throw new Error("Jawaban server belum lengkap.");
      if(expired(row.item)||document.hidden)return;
      row.url=url;row.link.href=url;row.notice="";row.item={...row.item,status:"issued"};
    }catch(error){if(mutation.generation===state.generation&&state.rows.get(id)===row)mutation.uncertain=true}
    finally{mutation.controller=null;if(mutation.generation===state.generation&&state.rows.get(id)===row)updateRow(row)}
  }
})();
