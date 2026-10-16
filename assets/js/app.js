const state={menu:[],store:null,cart:loadCart(),cartWriteFailed:false,menuReady:false,menuRequest:null,menuRetry:null,menuNodes:new Map(),cartNodes:new Map(),cartSignature:null,checkoutBusy:false,checkoutOpening:false,dialogGeneration:0,intent:null,modal:null,modalFocus:null,inertNodes:[],success:null,recovery:null,recoveryRequest:null,recoveryGeneration:0};
const $=s=>document.querySelector(s);
const rupiah=v=>`Rp ${Number(v).toLocaleString("id-ID")}`;
const INTENT_KEY="dapoer-checkout-intent-v1";
const INTENT_INDEX_KEY="dapoer-checkout-request-v1";
const DRAFT_KEY="dapoer-checkout-draft-v1";
const DRAFT_MAX_AGE=24*60*60*1000;
function cleanText(value,max){return typeof value==="string"?value.replace(/[\u0000-\u001F\u007F]/g," ").trim().slice(0,max):""}
document.addEventListener("DOMContentLoaded",init);

async function init(){
  bindUI();restoreCheckoutDraft();observeReveal();renderCart();restoreIntentNotice();refreshOrderRecovery();
  setInterval(()=>{if(!document.hidden)loadMenu()},15000);
  document.addEventListener("visibilitychange",()=>{if(document.hidden)saveCheckoutDraft();else{loadMenu();refreshOrderRecovery()}});
  window.addEventListener("online",()=>{if(!document.hidden){loadMenu();refreshOrderRecovery()}});
  window.addEventListener("pagehide",saveCheckoutDraft);
  window.addEventListener("pageshow",event=>{if(event.persisted)refreshOrderRecovery()});
  window.addEventListener("storage",event=>{if(event.key==="dapoer-pasta-cart"||event.key===null)syncCartFromStorage();if(event.key===window.DapoerOrderRecovery?.currentKey||event.key===null)refreshOrderRecovery()});
  await loadMenu();
}
function bindUI(){
  window.addEventListener("load",()=>setTimeout(()=>$("#preloader")?.classList.add("hide"),350));
  window.addEventListener("scroll",()=>$("#navbar")?.classList.toggle("scrolled",window.scrollY>20));
  $("#mobile-menu-button")?.addEventListener("click",()=>toggleMobileMenu(true));
  $("#mobile-menu-close")?.addEventListener("click",()=>toggleMobileMenu(false));
  document.querySelectorAll("#mobile-menu a").forEach(a=>a.addEventListener("click",()=>toggleMobileMenu(false)));
  $("#open-cart")?.addEventListener("click",()=>toggleCart(true));
  $("#close-cart")?.addEventListener("click",()=>toggleCart(false));
  $("#cart-overlay")?.addEventListener("click",e=>{if(e.target.id==="cart-overlay")toggleCart(false)});
  $("#checkout-button")?.addEventListener("click",openCheckout);
  $("#close-checkout")?.addEventListener("click",()=>toggleCheckout(false));
  $("#checkout-modal")?.addEventListener("click",e=>{if(e.target.id==="checkout-modal")toggleCheckout(false)});
  $("#checkout-form")?.addEventListener("submit",submitCheckout);
  for(const id of ["name","phone","address","payment"]){$("#checkout-"+id)?.addEventListener("input",event=>{event.target.setCustomValidity?.("");event.target.removeAttribute?.("aria-invalid")})}
  $("#checkout-retry")?.addEventListener("click",retryPendingCheckout);
  $("#checkout-done")?.addEventListener("click",()=>toggleCheckout(false));
  $("#order-confirmation-open")?.addEventListener("click",resumeOrderConfirmation);
  for(const id of ["name","phone","address","payment","notes"]){for(const event of ["input","change"])$("#checkout-"+id)?.addEventListener(event,saveCheckoutDraft)}
  $("#open-chat")?.addEventListener("click",()=>{const open=!$("#chat-box")?.classList.contains("open");$("#chat-box")?.classList.toggle("open",open);$("#open-chat")?.setAttribute("aria-expanded",String(open));renderOrderRecovery();if(open)$("#chat-input")?.focus()});
  $("#close-chat")?.addEventListener("click",closeChat);
  $("#chat-form")?.addEventListener("submit",sendChat);
  document.addEventListener("keydown",handleDialogKeyboard);
}
function closeChat(){$("#chat-box")?.classList.remove("open");$("#open-chat")?.setAttribute("aria-expanded","false");renderOrderRecovery();$("#open-chat")?.focus()}
async function loadMenu(){
  if(state.menuRequest)return state.menuRequest;
  state.menuRequest=fetchMenu();
  try{return await state.menuRequest}finally{state.menuRequest=null}
}
function validProduct(p){return p&&typeof p.id==="string"&&/^[a-z0-9-]{1,80}$/.test(p.id)&&typeof p.name==="string"&&Number.isSafeInteger(p.price)&&p.price>0&&Number.isSafeInteger(p.stock)&&p.stock>=0}
async function fetchMenu(){
  const root=$("#menu-grid");
  const controller=typeof AbortController==="function"?new AbortController():null;
  let timeout;
  if(state.menuRetry){state.menuRetry.disabled=true;state.menuRetry.textContent="Memuat menu…"}
  try{
    const data=await Promise.race([
      (async()=>{const res=await fetch("/api/menu",{cache:"no-store",headers:{Accept:"application/json"},...(controller?{signal:controller.signal}:{})});if(!res.ok)throw new Error("menu");return res.json()})(),
      new Promise((_,reject)=>{timeout=setTimeout(()=>{controller?.abort();reject(new Error("menu timeout"))},15000)})
    ]);
    if(!Array.isArray(data.products)||!data.products.length||data.products.some(p=>!validProduct(p))||new Set(data.products.map(p=>p.id)).size!==data.products.length)throw new Error("menu");
    state.menu=data.products;state.store=data.store||null;state.menuReady=true;
    const changedPrice=reconcileCart();renderMenu();renderCart();
    if(changedPrice&&state.modal==="checkout-modal"&&!state.checkoutBusy&&!state.success)checkoutNotice("Harga menu diperbarui. Periksa total terbaru sebelum menyimpan pesanan.");
    return true;
  }catch{
    state.menuReady=false;
    if(!state.menuNodes.size&&!state.menuRetry){const el=document.createElement("div"),message=document.createElement("p"),retry=document.createElement("button");el.className="menu-loading";message.textContent="Menu dan stok belum dapat dimuat. Silakan coba lagi atau hubungi WhatsApp Dapoer Pasta.";retry.className="menu-retry";retry.type="button";retry.addEventListener("click",loadMenu);el.append(message,retry);root?.replaceChildren(el);state.menuRetry=retry}
    for(const node of state.menuNodes.values()){node.add.disabled=true;node.stock.textContent="Stok belum dapat diperiksa"}
    renderCart();return false;
  }finally{clearTimeout(timeout);if(state.menuRetry){state.menuRetry.disabled=false;state.menuRetry.textContent="Coba muat menu lagi"}}
}
function localImage(value){return typeof value==="string"&&value.startsWith("/")&&!value.startsWith("//")&&!/[\u0000-\u001f]/.test(value)?value:""}
function renderMenu(){
  const root=$("#menu-grid");if(!root)return;
  const previous=[...state.menuNodes.keys()].join("|");
  const keep=new Set(state.menu.map(p=>p.id));for(const id of state.menuNodes.keys())if(!keep.has(id))state.menuNodes.delete(id);
  state.menu.forEach((p,i)=>{
    let node=state.menuNodes.get(p.id);
    if(!node){
      const card=document.createElement("article");card.className="product-card reveal show";card.setAttribute("data-motion-key",`product:${p.id}`);
      const media=document.createElement("div");media.className="product-image";
      const picture=document.createElement("picture"),source=document.createElement("source"),img=document.createElement("img");source.type="image/webp";picture.append(source,img);img.loading="lazy";img.decoding="async";
      const plane=document.createElement("div");plane.className="product-depth-plane";plane.append(picture);
      const badge=document.createElement("span");badge.className="product-badge";
      const price=document.createElement("span");price.className="product-price";media.append(plane,badge,price);
      const body=document.createElement("div");body.className="product-body";
      const idx=document.createElement("div");idx.className="product-index";
      const title=document.createElement("h3"),desc=document.createElement("p"),stock=document.createElement("div");stock.className="product-stock";
      const action=document.createElement("div");action.className="product-action";
      const add=document.createElement("button");add.className="add-button";add.type="button";add.addEventListener("click",()=>addToCart(p.id));
      const mark=document.createElement("span");mark.className="small-mark";mark.textContent="DP";
      action.append(add,mark);body.append(idx,title,desc,stock,action);card.append(media,body);
      node={card,source,img,badge,price,idx,title,desc,stock,add,imageKey:null};state.menuNodes.set(p.id,node);
    }
    const imageKey=[p.image,p.imageFallback,p.imageSrcset,p.imageWidth,p.imageHeight].join("|");
    if(node.imageKey!==imageKey){
      node.img.src=localImage(p.imageFallback)||localImage(p.image);node.img.alt=p.name;
      if(typeof p.imageSrcset==="string"&&!/[<>\n]/.test(p.imageSrcset)){node.source.srcset=p.imageSrcset;node.source.sizes="(max-width: 700px) calc(100vw - 40px), (max-width: 1050px) calc(50vw - 40px), 380px"}
      else node.source.srcset="";
      if(Number.isSafeInteger(p.imageWidth)&&p.imageWidth>0)node.img.width=p.imageWidth;
      if(Number.isSafeInteger(p.imageHeight)&&p.imageHeight>0)node.img.height=p.imageHeight;
      node.imageKey=imageKey;
    }
    node.badge.textContent=p.badge||"";node.price.textContent=rupiah(p.price);node.idx.textContent=String(i+1).padStart(2,"0")+".";node.title.textContent=p.name;node.desc.textContent=p.description||"";
    node.stock.textContent=p.stock>0?`Stok tersedia: ${p.stock}`:"Stok habis";node.stock.classList.toggle("sold-out",p.stock===0);
    node.add.disabled=p.stock<=0;node.add.textContent=p.stock>0?"Tambah ke keranjang →":"Stok habis";
    node.add.setAttribute("aria-label",p.stock>0?`Tambah ${p.name} ke keranjang`:`${p.name}: stok habis`);
  });
  if(previous!==state.menu.map(p=>p.id).join("|"))root.replaceChildren(...state.menu.map(p=>state.menuNodes.get(p.id).card));
  state.menuRetry=null;
  window.DapoerMotion?.reveal(root);
}
function validatedCart(value){
  if(!Array.isArray(value))return[];
  const items=new Map();
  for(const item of value.slice(0,100)){
    if(!item||typeof item.id!=="string"||!/^[a-z0-9-]{1,80}$/.test(item.id)||!Number.isSafeInteger(item.quantity)||item.quantity<1||item.quantity>2147483647)continue;
    const existing=items.get(item.id),quantity=(existing?.quantity||0)+item.quantity;if(!Number.isSafeInteger(quantity)||quantity>2147483647)continue;
    items.set(item.id,{id:item.id,name:cleanText(item.name,120)||"Menu tidak tersedia",price:Number.isSafeInteger(item.price)&&item.price>0?item.price:0,quantity});
  }
  return [...items.values()];
}
function readStoredCart(){try{return validatedCart(JSON.parse(localStorage.getItem("dapoer-pasta-cart")||"[]"))}catch{return null}}
function loadCart(){return readStoredCart()||[]}
function persistCart(){try{localStorage.setItem("dapoer-pasta-cart",JSON.stringify(state.cart));state.cartWriteFailed=false}catch{state.cartWriteFailed=true}}
function syncCartFromStorage(){if(state.cartWriteFailed)return;const cart=readStoredCart();if(cart===null)return;state.cart=cart;reconcileCart();renderCart()}
function reconcileCart(){
  state.cart=validatedCart(state.cart);let changed=false;
  for(const item of state.cart){const product=state.menu.find(p=>p.id===item.id);if(product){if(item.price!==product.price)changed=true;item.price=product.price;item.name=product.name}}
  return changed;
}
function addToCart(id){
  const p=state.menu.find(x=>x.id===id);if(!p)return;
  const found=state.cart.find(x=>x.id===id),available=stockFor(id);
  if(available===null){showToast("Stok belum dapat diperiksa. Silakan coba lagi.");return}
  if((found?.quantity||0)>=available){showToast(available?`Stok ${p.name} tersisa ${available}.`:"Stok produk habis.");return}
  if(found)found.quantity++;else state.cart.push({id:p.id,name:p.name,price:p.price,quantity:1});
  persistCart();renderCart();showToast(`${p.name} ditambahkan.`);
}
function updateQuantity(id,delta){
  const item=state.cart.find(x=>x.id===id);if(!item||!Number.isSafeInteger(delta))return;
  if(delta>0){const available=stockFor(id);if(available===null||item.quantity+delta>available){showToast(available===null?"Stok belum dapat diperiksa.":`Stok ${item.name} tersisa ${available}.`);return}}
  item.quantity+=delta;if(item.quantity<=0)state.cart=state.cart.filter(x=>x.id!==id);persistCart();renderCart();
}
function removeCartItem(id){state.cart=state.cart.filter(x=>x.id!==id);persistCart();renderCart()}
function renderCart(){
  renderOrderRecovery();
  const root=$("#cart-items");if(!root)return;
  $("#cart-count").textContent=state.cart.reduce((s,x)=>s+x.quantity,0);
  const checkout=$("#checkout-button");if(checkout){const pending=loadIntent();checkout.disabled=state.checkoutOpening||state.checkoutBusy||(!pending&&(!state.cart.length||!cartStockAvailable()));checkout.textContent=state.checkoutOpening?"Memeriksa stok…":pending?"Periksa Pesanan Sebelumnya":"Lanjutkan Checkout";checkout.setAttribute("aria-busy",String(state.checkoutOpening))}
  const signature=state.cart.map(x=>x.id).join("|");
  if(!state.cart.length){
    if(state.cartSignature!==""){const empty=document.createElement("div");empty.className="empty-cart";empty.innerHTML='<i class="fa-solid fa-bag-shopping" aria-hidden="true"></i><p>Keranjang masih kosong.</p>';root.replaceChildren(empty);state.cartNodes.clear()}
    state.cartSignature="";$("#cart-total").textContent=rupiah(0);if(!state.checkoutBusy&&!state.success)$("#checkout-total").textContent=rupiah(0);return;
  }
  const keep=new Set(state.cart.map(x=>x.id));for(const id of state.cartNodes.keys())if(!keep.has(id))state.cartNodes.delete(id);
  for(const item of state.cart){
    let node=state.cartNodes.get(item.id);
    if(!node){
      const row=document.createElement("div");row.className="cart-item";
      const head=document.createElement("div");head.className="cart-item-head";
      const info=document.createElement("div"),title=document.createElement("h3"),meta=document.createElement("small");info.append(title,meta);
      const remove=document.createElement("button");remove.type="button";remove.className="cart-remove";remove.setAttribute("aria-label",`Hapus ${item.name}`);remove.innerHTML='<i class="fa-solid fa-trash" aria-hidden="true"></i>';remove.addEventListener("click",()=>removeCartItem(item.id));head.append(info,remove);
      const foot=document.createElement("div");foot.className="cart-row";const qty=document.createElement("div");qty.className="quantity";
      const minus=document.createElement("button");minus.type="button";minus.textContent="−";minus.setAttribute("aria-label",`Kurangi ${item.name}`);minus.addEventListener("click",()=>updateQuantity(item.id,-1));
      const value=document.createElement("span"),plus=document.createElement("button");plus.type="button";plus.textContent="+";plus.setAttribute("aria-label",`Tambah ${item.name}`);plus.addEventListener("click",()=>updateQuantity(item.id,1));qty.append(minus,value,plus);
      const sub=document.createElement("div");sub.className="subtotal";foot.append(qty,sub);row.append(head,foot);node={row,title,meta,value,plus,sub};state.cartNodes.set(item.id,node);
    }
    const available=stockFor(item.id);node.title.textContent=item.name;node.meta.className="";
    node.meta.textContent=`${rupiah(item.price)} / item · ${available===null?"Stok belum dapat diperiksa":`Stok: ${available}`}`;
    if(available!==null&&item.quantity>available){node.meta.className="cart-stock-error";node.meta.textContent+=available===0?" · Hapus produk yang habis":" · Kurangi jumlah pesanan"}
    node.value.textContent=item.quantity;node.plus.disabled=available===null||item.quantity>=available;node.sub.textContent=rupiah(item.price*item.quantity);
  }
  if(state.cartSignature!==signature)root.replaceChildren(...state.cart.map(x=>state.cartNodes.get(x.id).row));state.cartSignature=signature;
  $("#cart-total").textContent=rupiah(cartTotal());if(!state.checkoutBusy&&!state.success)$("#checkout-total").textContent=rupiah(cartTotal());
}
function stockFor(id){const p=state.menu.find(x=>x.id===id);return state.menuReady&&Number.isSafeInteger(p?.stock)&&p.stock>=0?p.stock:null}
function cartStockAvailable(items=state.cart){return items.every(item=>{const available=stockFor(item.id);return available!==null&&item.quantity>0&&item.quantity<=available})}
function cartTotal(){return state.cart.reduce((sum,item)=>sum+item.price*item.quantity,0)}
function setDialog(id,open,focusSelector){
  const modal=$("#"+id);if(!modal)return;
  if(state.modal==="checkout-modal"&&(!open||id!=="checkout-modal"))saveCheckoutDraft();
  state.dialogGeneration++;if(state.checkoutOpening){state.checkoutOpening=false;renderCart()}
  if(open){
    const origin=state.modalFocus||document.activeElement;
    for(const name of ["cart-overlay","checkout-modal","mobile-menu"]){if(name!==id){$("#"+name)?.classList.remove("open");$("#"+name)?.setAttribute("aria-hidden","true")}}
    for(const item of state.inertNodes)item.node.inert=item.previous;state.inertNodes=[];
    state.modal=id;state.modalFocus=origin;
    for(const node of Array.from(document.body.children||[])){if(node!==modal&&node.id!=="toast"&&node.tagName!=="SCRIPT"){state.inertNodes.push({node,previous:!!node.inert});node.inert=true}}
    modal.inert=false;modal.classList.add("open");modal.setAttribute("aria-hidden","false");document.body.classList.add("no-scroll");
    const focus=$(focusSelector)||modal.querySelector?.('[role="dialog"]')||modal;focus.focus?.();
  }else{
    modal.classList.remove("open");modal.setAttribute("aria-hidden","true");
    if(state.modal===id){for(const item of state.inertNodes)item.node.inert=item.previous;state.inertNodes=[];state.modal=null;document.body.classList.remove("no-scroll");const focus=state.modalFocus;state.modalFocus=null;if(focus?.isConnected!==false)focus?.focus?.()}
  }
  $("#mobile-menu-button")?.setAttribute("aria-expanded",String(state.modal==="mobile-menu"));
  renderOrderRecovery();
}
function handleDialogKeyboard(event){
  if(!state.modal){if(event.key==="Escape"&&$("#chat-box")?.classList.contains("open"))closeChat();return}
  const modal=$("#"+state.modal);
  if(event.key==="Escape"){event.preventDefault();setDialog(state.modal,false);return}
  if(event.key!=="Tab")return;
  const focusable=Array.from(modal.querySelectorAll('a[href],button,input,textarea,select,[tabindex="0"]')).filter(node=>!node.disabled&&!node.hidden&&node.getClientRects().length&&!node.closest('[hidden]'));
  if(!focusable.length){event.preventDefault();(modal.querySelector('[role="dialog"]')||modal).focus();return}
  const first=focusable[0],last=focusable[focusable.length-1];
  if(event.shiftKey&&(document.activeElement===first||!modal.contains(document.activeElement))){event.preventDefault();last.focus()}else if(!event.shiftKey&&(document.activeElement===last||!modal.contains(document.activeElement))){event.preventDefault();first.focus()}
}
function toggleCart(open){setDialog("cart-overlay",open,"#close-cart")}
function toggleCheckout(open){setDialog("checkout-modal",open,state.success?"#checkout-success-title":"#checkout-name")}
function toggleMobileMenu(open){setDialog("mobile-menu",open,"#mobile-menu-close")}
function checkoutNotice(message){const notice=$("#checkout-notice");if(notice){notice.textContent=message||"";notice.hidden=!message}if($("#checkout-contact-link"))$("#checkout-contact-link").hidden=true}
function resetSuccess(){state.success=null;if($("#checkout-success"))$("#checkout-success").hidden=true;if($("#checkout-form"))$("#checkout-form").hidden=false;$("#checkout-title").textContent="Data Pemesan"}
async function openCheckout(){
  if(state.checkoutOpening||state.checkoutBusy)return;
  resetSuccess();restoreIntentNotice();
  if(!state.cart.length&&!loadIntent()){showToast("Pilih menu terlebih dahulu.");toggleCart(true);return}
  if(loadIntent()){$("#checkout-total").textContent=rupiah(cartTotal());toggleCheckout(true);return}
  const navigation=++state.dialogGeneration;state.checkoutOpening=true;renderCart();
  try{
    await loadMenu();if(navigation!==state.dialogGeneration)return;
    if(!state.cart.length||!cartStockAvailable()){showToast("Periksa stok terbaru dan sesuaikan jumlah di keranjang.");return}
    $("#checkout-total").textContent=rupiah(cartTotal());toggleCheckout(true);
  }finally{if(navigation===state.dialogGeneration){state.checkoutOpening=false;renderCart()}}
}
function customerSnapshot(){return {name:cleanText($("#checkout-name").value,80),phone:cleanText($("#checkout-phone").value,24).replace(/[^0-9+\- ()]/g,""),address:cleanText($("#checkout-address").value,500),paymentMethod:cleanText($("#checkout-payment").value,30),notes:cleanText($("#checkout-notes").value,300)}}
function saveCheckoutDraft(){
  const customer=customerSnapshot();
  try{if(Object.values(customer).some(Boolean))sessionStorage.setItem(DRAFT_KEY,JSON.stringify({savedAt:Date.now(),customer}));else sessionStorage.removeItem(DRAFT_KEY)}catch{}
}
function restoreCheckoutDraft(){
  let draft;
  try{draft=JSON.parse(sessionStorage.getItem(DRAFT_KEY)||"null")}catch{}
  if(!draft&&loadIntent())draft={savedAt:Date.now(),customer:loadIntent().payload.customer};
  if(!draft||!Number.isFinite(draft.savedAt)||draft.savedAt>Date.now()+60000||Date.now()-draft.savedAt>=DRAFT_MAX_AGE||!draft.customer||["name","phone","address","paymentMethod","notes"].some(key=>typeof draft.customer[key]!=="string")){try{sessionStorage.removeItem(DRAFT_KEY)}catch{}return}
  for(const[id,key,max]of [["name","name",80],["phone","phone",24],["address","address",500],["payment","paymentMethod",30],["notes","notes",300]]){
    const field=$("#checkout-"+id),value=cleanText(draft.customer[key],max);
    if(field&&!field.value&&(id!=="payment"||["OVO","ShopeePay","DANA","Transfer Bank"].includes(value)))field.value=value;
  }
}
function renderOrderRecovery(){
  const root=$("#order-confirmation"),button=$("#order-confirmation-open"),summary=$("#order-confirmation-summary"),message=$("#order-confirmation-message");
  if(!root||!button||!summary||!message)return;
  const current=window.DapoerOrderRecovery?.getCurrent(),record=state.recovery?.record;
  const available=!!current&&!!record&&current.id===record.id&&current.token===record.token;
  root.hidden=!available||!!state.modal||!!$("#chat-box")?.classList.contains("open");
  button.disabled=state.recovery?.status==="checking"||state.checkoutBusy||state.checkoutOpening;
  button.textContent=state.recovery?.status==="checking"?"Memeriksa pesanan…":"Lanjutkan konfirmasi";
  if(!available)return;
  summary.textContent=`${record.queueNumber?`Antrean A${String(record.queueNumber).padStart(3,"0")} · `:""}${record.id} · ${rupiah(record.total)}`;
  message.textContent=state.recovery.status==="offline"?"Pesanan tetap tersimpan. Sambungkan internet, lalu lanjutkan konfirmasi.":"Data pemesan sudah tersimpan. Lanjutkan konfirmasi melalui WhatsApp.";
  message.hidden=state.recovery.status!=="offline";
}
function updateSavedConfirmation(record,whatsapp,message,order){
  if(!record||state.success?.id!==record.id||state.success?.token!==record.token)return;
  const link=$("#checkout-whatsapp-link");if(link){link.hidden=!whatsapp;if(whatsapp)link.href=whatsapp;else link.removeAttribute("href")}
  const addition=$("#checkout-add-menu-link");if(addition){addition.hidden=!whatsapp||!canAddToSavedOrder(order);if(!addition.hidden)addition.href=record.trackingUrl+"#tambah-menu";else addition.removeAttribute("href")}
  if(order){state.success={...state.success,total:order.total};$("#checkout-success-order").textContent=`${record.id} · ${rupiah(order.total)}`}
  if(message)checkoutNotice(message);
  else if(whatsapp&&state.modal==="checkout-modal")checkoutNotice(state.cart.length?"Perubahan terbaru di keranjang tetap disimpan untuk pesanan berikutnya.":"");
}
function canAddToSavedOrder(order){return !order||["baru","diproses"].includes(order.status)&&order.canAddItems!==false&&window.DapoerOrderRecovery?.validAdditions?.(order.additions)!==false&&(order.additions||[]).length<100&&!(order.additions||[]).some(addition=>addition.status==="pending")}
async function refreshOrderRecovery(){
  let record=window.DapoerOrderRecovery?.getCurrent();
  if(!record){const legacy=window.DapoerOrderRecovery?.getLegacyReference();if(legacy)record={...legacy,trackingUrl:`/track/?id=${encodeURIComponent(legacy.id)}&token=${encodeURIComponent(legacy.token)}`,legacy:true}}
  if(!record){updateSavedConfirmation(state.success,null,"Tautan konfirmasi di perangkat ini sudah berakhir. Pesanan tetap tercatat; buka Lacak pesanan untuk memeriksa status dan menghubungi admin.");state.recovery=null;state.recoveryGeneration++;state.recoveryRequest?.controller?.abort();state.recoveryRequest=null;renderOrderRecovery();return null}
  if(state.success&&(state.success.id!==record.id||state.success.token!==record.token))updateSavedConfirmation(state.success,null,"Ada pesanan tersimpan yang lebih baru di perangkat ini. Gunakan Lacak pesanan untuk memeriksa pesanan ini.");
  const key=`${record.id}:${record.token}`;
  if(state.recoveryRequest?.key===key)return state.recoveryRequest.promise;
  state.recoveryRequest?.controller?.abort();
  const turn=++state.recoveryGeneration,controller=typeof AbortController==="function"?new AbortController():null;
  updateSavedConfirmation(record,null,"Memeriksa status pesanan sebelum melanjutkan konfirmasi…");
  state.recovery={record,status:"checking",order:null};renderOrderRecovery();
  const request={key,controller,promise:null};state.recoveryRequest=request;
  request.promise=(async()=>{
    let timeout;
    try{
      const result=await Promise.race([
        (async()=>{const response=await fetch(`/api/track?id=${encodeURIComponent(record.id)}&token=${encodeURIComponent(record.token)}`,{cache:"no-store",credentials:"same-origin",headers:{Accept:"application/json"},...(controller?{signal:controller.signal}:{})});return {response,data:await response.json()}})(),
        new Promise((_,reject)=>{timeout=setTimeout(()=>{controller?.abort();reject(new Error("recovery timeout"))},12000)})
      ]);
      const current=window.DapoerOrderRecovery?.getCurrent();
      const legacy=record.legacy?window.DapoerOrderRecovery?.getLegacyReference():null;
      const stillCurrent=record.legacy?!current&&legacy?.id===record.id&&legacy?.token===record.token&&legacy?.savedAt===record.savedAt:current?.id===record.id&&current?.token===record.token;
      if(turn!==state.recoveryGeneration||!stillCurrent)return null;
      if(!result.response.ok){if([400,401,403,404].includes(result.response.status)){updateSavedConfirmation(record,null,"Tautan pesanan ini tidak dapat diverifikasi. Hubungi admin untuk memeriksa pesanan yang sudah tersimpan.");window.DapoerOrderRecovery?.forget(record);state.recovery=null;return null}throw new Error("recovery unavailable")}
      const order=result.data.order;
      if(order?.id!==record.id||!Number.isSafeInteger(order.total)||order.total<1||!["baru","diproses","dikirim","selesai","dibatalkan"].includes(order.status)||typeof order.updatedAt!=="string"||!Number.isFinite(new Date(order.updatedAt).getTime())||!Array.isArray(order.items)||!order.items.length||order.items.length>100||order.items.some(item=>!item||typeof item.name!=="string"||!item.name.trim()||!Number.isSafeInteger(item.quantity)||item.quantity<1||!Number.isSafeInteger(item.subtotal)||item.subtotal<0)||(order.canAddItems!==undefined&&typeof order.canAddItems!=="boolean")||window.DapoerOrderRecovery?.validAdditions?.(order.additions)===false)throw new Error("recovery invalid");
      if(["selesai","dibatalkan"].includes(order.status)){updateSavedConfirmation(record,null,order.status==="dibatalkan"?"Pesanan ini sudah dibatalkan. Konfirmasi WhatsApp untuk pesanan ini dinonaktifkan.":"Pesanan ini sudah selesai. Anda tetap dapat melihat status melalui Lacak pesanan.");window.DapoerOrderRecovery?.forget(record);state.recovery=null;return null}
      const confirmedRecord=record.legacy?window.DapoerOrderRecovery?.recoverLegacy({id:record.id,token:record.token,order}):record;
      if(!confirmedRecord)throw new Error("recovery invalid");
      const whatsapp=window.DapoerOrderRecovery?.getWhatsAppUrl({id:record.id,token:record.token,order});
      if(!whatsapp)throw new Error("recovery invalid");
      const verified={...confirmedRecord,total:order.total,queueNumber:Number.isSafeInteger(order.queueNumber)&&order.queueNumber>0?order.queueNumber:null,queueDate:typeof order.queueDate==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(order.queueDate)?order.queueDate:null};
      state.recovery={record:verified,order,status:"ready",whatsapp};updateSavedConfirmation(verified,whatsapp,null,order);return state.recovery;
    }catch{if(turn===state.recoveryGeneration){state.recovery={record,status:"offline",order:null};updateSavedConfirmation(record,null,"Status belum dapat diperiksa. Sambungkan internet, lalu tutup layar ini dan tekan Lanjutkan konfirmasi untuk mencoba kembali.")}return null}
    finally{clearTimeout(timeout);if(state.recoveryRequest===request)state.recoveryRequest=null;renderOrderRecovery()}
  })();
  return request.promise;
}
async function resumeOrderConfirmation(){
  if(state.checkoutBusy||state.checkoutOpening)return;
  const navigation=state.dialogGeneration,recovery=await refreshOrderRecovery();
  if(!recovery){if(state.recovery?.status==="offline")showToast("Sambungkan internet untuk memeriksa pesanan yang sudah tersimpan.");return}
  const current=window.DapoerOrderRecovery?.getCurrent();
  if(navigation!==state.dialogGeneration||document.hidden||$("#chat-box")?.classList.contains("open")||current?.id!==recovery.record.id||current?.token!==recovery.record.token)return;
  showCheckoutSuccess(recovery.record,recovery.whatsapp,recovery.record.total,!!state.cart.length,true);
}
function validateCustomer(customer){
  const checks=[["name",customer.name.length>=2,"Tulis nama lengkap minimal 2 karakter."],["phone",customer.phone.replace(/\D/g,"").length>=8,"Tulis nomor WhatsApp yang benar, minimal 8 angka."],["address",customer.address.length>=5,"Tulis alamat pengiriman minimal 5 karakter."],["payment",["OVO","ShopeePay","DANA","Transfer Bank"].includes(customer.paymentMethod),"Pilih metode pembayaran yang tersedia."]];
  for(const[id]of checks){const field=$("#checkout-"+id);field?.setCustomValidity?.("");field?.removeAttribute?.("aria-invalid")}
  const invalid=checks.find(([,valid])=>!valid);if(!invalid)return true;
  const field=$("#checkout-"+invalid[0]);field?.setCustomValidity?.(invalid[2]);field?.setAttribute?.("aria-invalid","true");checkoutNotice(invalid[2]);field?.focus?.();field?.reportValidity?.();return false;
}
function sortedItems(items){return items.map(item=>({id:item.id,quantity:item.quantity})).sort((a,b)=>a.id.localeCompare(b.id))}
function canonicalPayload(payload,withTotal=true){return JSON.stringify({items:sortedItems(payload.items),customer:{name:payload.customer.name,phone:payload.customer.phone,address:payload.customer.address,paymentMethod:payload.customer.paymentMethod,notes:payload.customer.notes},...(withTotal?{expectedTotal:payload.expectedTotal}:{})})}
function uuid(){
  const secure=window.crypto||globalThis.crypto;if(secure?.randomUUID)return secure.randomUUID();
  const bytes=new Uint8Array(16);if(secure?.getRandomValues)secure.getRandomValues(bytes);else for(let i=0;i<16;i++)bytes[i]=Math.floor(Math.random()*256);
  bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;const hex=Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
function validIntent(value){
  if(!value||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value.requestId||"")||!Number.isSafeInteger(value.payload?.expectedTotal)||value.payload.expectedTotal<1||!Array.isArray(value.payload.items)||!value.payload.items.length||value.payload.items.some(item=>typeof item?.id!=="string"||!/^[a-z0-9-]{1,80}$/.test(item.id)||!Number.isSafeInteger(item.quantity)||item.quantity<1)||!value.payload.customer||["name","phone","address","paymentMethod","notes"].some(key=>typeof value.payload.customer[key]!=="string"))return null;
  return value;
}
function loadIntent(){if(state.intent)return state.intent;try{state.intent=validIntent(JSON.parse(sessionStorage.getItem(INTENT_KEY)||"null"))}catch{}return state.intent}
async function payloadDigest(payload){try{const secure=window.crypto||globalThis.crypto;if(!secure?.subtle||typeof TextEncoder!=="function")return null;const digest=await secure.subtle.digest("SHA-256",new TextEncoder().encode(canonicalPayload(payload)));return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,"0")).join("")}catch{return null}}
async function intentFor(payload){
  const existing=loadIntent();if(existing&&canonicalPayload(existing.payload,false)===canonicalPayload(payload,false))return existing;
  const digest=await payloadDigest(payload);let requestId=uuid();
  if(digest){try{const saved=JSON.parse(localStorage.getItem(INTENT_INDEX_KEY)||"null");if(saved?.digest===digest&&/^[a-f0-9-]{36}$/i.test(saved.requestId||""))requestId=saved.requestId;localStorage.setItem(INTENT_INDEX_KEY,JSON.stringify({requestId,digest}))}catch{}}
  state.intent={requestId,payload};try{sessionStorage.setItem(INTENT_KEY,JSON.stringify(state.intent))}catch{}return state.intent;
}
function clearIntent(requestId){
  if(loadIntent()?.requestId!==requestId)return;state.intent=null;
  try{sessionStorage.removeItem(INTENT_KEY)}catch{}
  try{const record=JSON.parse(localStorage.getItem(INTENT_INDEX_KEY)||"null");if(record?.requestId===requestId)localStorage.removeItem(INTENT_INDEX_KEY)}catch{}
  if($("#checkout-retry"))$("#checkout-retry").hidden=true;
}
function restoreIntentNotice(){const intent=loadIntent();if($("#checkout-retry"))$("#checkout-retry").hidden=!intent;if(intent)checkoutNotice("Ada pesanan yang belum mendapat konfirmasi dari koneksi sebelumnya. Periksa kembali pesanan tersebut agar tidak tersimpan dua kali.")}
async function retryPendingCheckout(){const intent=loadIntent();if(!intent||state.checkoutBusy)return;await saveCheckout(intent,intent.payload,JSON.stringify(sortedItems(state.cart)),customerSnapshot())}
async function submitCheckout(e){
  e.preventDefault();if(state.checkoutBusy)return;
  saveCheckoutDraft();
  if(!state.cart.length){showToast("Keranjang kosong.");return}
  const snapshot={items:sortedItems(state.cart),customer:customerSnapshot(),expectedTotal:cartTotal()};
  const existing=loadIntent();const replay=existing&&canonicalPayload(existing.payload,false)===canonicalPayload(snapshot,false);
  if(existing&&!replay){restoreIntentNotice();checkoutNotice("Periksa kembali pesanan sebelumnya terlebih dahulu. Perubahan baru di keranjang dan data pemesan akan tetap disimpan.");return}
  if(!replay&&(!validateCustomer(snapshot.customer)||($("#checkout-form")?.reportValidity&&!$("#checkout-form").reportValidity())))return;
  const cartBefore=JSON.stringify(sortedItems(state.cart)),customerBefore=customerSnapshot();
  state.checkoutBusy=true;setCheckoutBusy(true);
  try{
    if(!replay){
      const loaded=await loadMenu();if(!loaded)throw new Error("Menu belum dapat diperiksa. Coba lagi sebentar.");
      const latestTotal=snapshot.items.reduce((sum,item)=>sum+(state.menu.find(p=>p.id===item.id)?.price||0)*item.quantity,0);
      if(latestTotal!==snapshot.expectedTotal){checkoutNotice("Harga diperbarui. Periksa total terbaru, lalu simpan kembali jika sudah sesuai.");showToast("Harga diperbarui. Periksa total pesanan.");return}
      if(!cartStockAvailable(snapshot.items))throw new Error("Stok berubah. Sesuaikan jumlah di keranjang sebelum memesan.");
    }
    const intent=await intentFor(snapshot);await postCheckout(intent,snapshot,cartBefore,customerBefore);
  }catch(error){checkoutNotice(error.message||"Pesanan belum mendapat konfirmasi. Silakan coba lagi.");showToast(error.message||"Pesanan belum dapat disimpan.")}finally{state.checkoutBusy=false;setCheckoutBusy(false)}
}
async function saveCheckout(intent,snapshot,cartBefore,customerBefore){
  state.checkoutBusy=true;setCheckoutBusy(true);
  try{await postCheckout(intent,snapshot,cartBefore,customerBefore)}catch{checkoutNotice("Koneksi belum memastikan hasilnya. Tekan Periksa kembali pesanan sebelumnya untuk melanjutkan pesanan yang sama.");showToast("Koneksi terputus. Pesanan yang sama dapat diperiksa kembali.");restoreIntentNotice()}finally{state.checkoutBusy=false;setCheckoutBusy(false)}
}
function setCheckoutBusy(busy){const button=$("#checkout-submit");if(button){button.disabled=busy;button.textContent=busy?"Menyimpan pesanan…":"Simpan Pesanan"}const retry=$("#checkout-retry");if(retry)retry.disabled=busy;$("#checkout-form")?.setAttribute("aria-busy",String(busy));if(!busy&&!state.success)$("#checkout-total").textContent=rupiah(cartTotal());renderCart()}
async function postCheckout(intent,snapshot,cartBefore,customerBefore){
  const controller=typeof AbortController==="function"?new AbortController():null;const timeout=setTimeout(()=>controller?.abort(),30000);
  let res,data;
  try{res=await fetch("/api/order",{method:"POST",headers:{"Content-Type":"application/json",Accept:"application/json"},body:JSON.stringify({...intent.payload,requestId:intent.requestId}),...(controller?{signal:controller.signal}:{})});data=await res.json()}catch{restoreIntentNotice();throw new Error("Koneksi belum memastikan hasil pesanan. Coba lagi untuk memeriksa pesanan yang sama.")}finally{clearTimeout(timeout)}
  if(!res.ok){
    if(res.status===409&&data.code==="PRICE_CHANGED"){
      clearIntent(intent.requestId);await loadMenu();checkoutNotice("Harga menu berubah sebelum pesanan disimpan. Periksa total terbaru lalu simpan kembali.");showToast(data.error||"Harga berubah. Periksa total terbaru.");return;
    }
    if(res.status===409&&data.code==="INSUFFICIENT_STOCK"){
      clearIntent(intent.requestId);await loadMenu();toggleCart(true);showToast(data.error||"Stok tidak mencukupi. Sesuaikan jumlah di keranjang.");return;
    }
    if(res.status===409&&data.code==="REQUEST_CONFLICT"){
      restoreIntentNotice();checkoutNotice("Nomor permintaan ini sudah digunakan. Hubungi WhatsApp admin untuk memeriksa pesanan yang sudah tersimpan sebelum membuat pesanan baru. Data di keranjang tetap disimpan.");if($("#checkout-contact-link"))$("#checkout-contact-link").hidden=false;showToast(data.error||"Hubungi admin untuk memeriksa pesanan sebelum memesan lagi.");return;
    }
    if(res.status>=400&&res.status<500&&res.status!==429)clearIntent(intent.requestId);
    else restoreIntentNotice();
    throw new Error(data.error||"Pesanan belum mendapat konfirmasi. Coba lagi untuk melanjutkan pesanan yang sama.");
  }
  const whatsapp=window.DapoerOrderRecovery?.safeWhatsApp(data.whatsappUrl);
  if(!whatsapp||!Array.isArray(data.order?.items)||!data.order.items.length||!Number.isSafeInteger(data.order.total)||data.order.total<1||data.order.total!==intent.payload.expectedTotal||data.persisted===false)throw new Error("Pesanan belum mendapat konfirmasi lengkap. Periksa kembali pesanan yang sama.");
  const record=window.DapoerOrderRecovery?.remember(data);
  if(!record)throw new Error("Pesanan belum mendapat konfirmasi lengkap. Periksa kembali pesanan yang sama.");
  clearIntent(intent.requestId);
  syncCartFromStorage();
  const unchanged=JSON.stringify(sortedItems(state.cart))===cartBefore&&JSON.stringify(sortedItems(state.cart))===JSON.stringify(sortedItems(intent.payload.items));
  if(unchanged){state.cart=[];persistCart();renderCart()}
  if(JSON.stringify(customerBefore)===JSON.stringify(intent.payload.customer)&&JSON.stringify(customerSnapshot())===JSON.stringify(customerBefore))$("#checkout-form")?.reset();
  saveCheckoutDraft();
  state.recoveryGeneration++;state.recoveryRequest?.controller?.abort();state.recoveryRequest=null;
  state.recovery={record,status:"ready",whatsapp,order:null};
  showCheckoutSuccess(record,whatsapp,data.order.total,!unchanged);loadMenu();
  // Checkout idempotency preserves its original snapshot. Tracking supplies the
  // current total if another tab has since added menus or changed the status.
  refreshOrderRecovery();
}
function showCheckoutSuccess(record,whatsapp,total,cartPreserved,restored=false){
  state.success=record;checkoutNotice(cartPreserved?"Perubahan terbaru di keranjang tetap disimpan untuk pesanan berikutnya.":"");
  $("#checkout-form").hidden=true;$("#checkout-success").hidden=false;$("#checkout-title").textContent="Pesanan Tersimpan";
  $("#checkout-success-order").textContent=`${record.id} · ${rupiah(total)}`;
  const queue=$("#checkout-success-queue");queue.hidden=!record.queueNumber;queue.textContent=record.queueNumber?`Nomor antrean A${String(record.queueNumber).padStart(3,"0")}${record.queueDate?` · ${record.queueDate} WIB`:""}`:"";
  $("#checkout-whatsapp-link").hidden=false;$("#checkout-whatsapp-link").href=whatsapp;$("#checkout-tracking-link").href=record.trackingUrl;
  const addition=$("#checkout-add-menu-link");if(addition){addition.hidden=!canAddToSavedOrder(state.recovery?.order);if(!addition.hidden)addition.href=record.trackingUrl+"#tambah-menu";else addition.removeAttribute("href")}
  toggleCheckout(true);if(!restored)showToast(`Pesanan ${record.id} tersimpan.`);
}
async function sendChat(e){
  e.preventDefault();const input=$("#chat-input"),message=input.value.trim();if(!message)return;
  addChatMessage(message,"user-message");input.value="";const pending=addChatMessage("Concierge sedang menyiapkan jawaban…","bot-message");
  try{const res=await fetch("/api/chat",{method:"POST",headers:{"Content-Type":"application/json",Accept:"application/json"},body:JSON.stringify({message})});const data=await res.json();pending.textContent=data.reply||"Maaf, saya belum dapat menjawab. Silakan hubungi WhatsApp Dapoer Pasta."}catch{pending.textContent="Maaf, asisten sedang sibuk. Silakan hubungi WhatsApp Dapoer Pasta."}
}
function addChatMessage(text,className){const el=document.createElement("div");el.className=`chat-message ${className}`;el.textContent=text;$("#chat-messages").append(el);el.scrollIntoView({behavior:"smooth",block:"end"});return el}
function showToast(message){$("#toast-message").textContent=message;$("#toast").classList.add("show");clearTimeout(showToast.timer);showToast.timer=setTimeout(()=>$("#toast").classList.remove("show"),5000)}
function observeReveal(){if(window.DapoerMotion){window.DapoerMotion.reveal();return}if(typeof IntersectionObserver!=="function"){document.querySelectorAll(".reveal").forEach(el=>el.classList.add("show"));return}const obs=new IntersectionObserver(entries=>entries.forEach(e=>{if(e.isIntersecting){e.target.classList.add("show");obs.unobserve(e.target)}}),{threshold:.1});document.querySelectorAll(".reveal").forEach(el=>obs.observe(el))}
