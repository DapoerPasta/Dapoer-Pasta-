(()=>{
const ORDER_TIME_ZONE="Asia/Jakarta";
const ORDER_PAGE_SIZE=100;
const state={orders:[],filter:"all",query:"",receiptPaper:"80",initialized:false,pollTimer:null,rolloverTimer:null,selectedDate:todayInWib(),followingToday:true,pageCount:1,pagination:null,summary:null,seenIds:new Set(),generation:0,request:null};
const $=s=>document.querySelector(s);
const rupiah=v=>`Rp ${Number(v||0).toLocaleString("id-ID")}`;
function signalAdminEvent(name,detail){
  if(typeof document.dispatchEvent==="function"&&typeof CustomEvent==="function")document.dispatchEvent(new CustomEvent(name,{detail}));
}

// Use the shop's calendar even when the administrator's device is abroad.
function todayInWib(now=new Date()){
  const parts=new Intl.DateTimeFormat("en-CA",{timeZone:ORDER_TIME_ZONE,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(now);
  const part=type=>parts.find(p=>p.type===type).value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
function validOrderDate(value){
  if(typeof value!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
  const date=new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===value;
}
function shiftOrderDate(value,days){
  if(!validOrderDate(value))return null;
  const date=new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate()+days);
  return date.toISOString().slice(0,10);
}
function orderDateLabel(value){
  return new Date(`${value}T12:00:00Z`).toLocaleDateString("id-ID",{timeZone:"UTC",weekday:"long",day:"numeric",month:"long",year:"numeric"});
}
function millisecondsToWibMidnight(now=new Date()){
  const shifted=now.getTime()+7*60*60*1000;
  return 24*60*60*1000-(shifted%(24*60*60*1000));
}
function mergeOrders(previous,next){
  const orders=new Map(previous.map(order=>[order.id,order]));
  next.forEach(order=>orders.set(order.id,order));
  return Array.from(orders.values()).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at)||String(b.id).localeCompare(String(a.id)));
}

// An older cached copy of this script cannot initialize the daily dashboard.
window.DapoerAdminDailyHistory=true;
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init);
else init();

async function init(){
  bind();
  updateDateControls();
  await checkSession();
}

function bind(){
  $("#login-form").addEventListener("submit",login);
  const passwordToggle=$("#toggle-admin-password");
  if(passwordToggle){
    passwordToggle.hidden=false;
    setPasswordVisibility(false);
    passwordToggle.addEventListener("click",()=>setPasswordVisibility($("#admin-password").type==="password",true));
  }
  $("#logout-button").addEventListener("click",logout);
  $("#refresh-orders").addEventListener("click",()=>loadOrders(false));
  $("#enable-notifications").addEventListener("click",enableNotifications);
  $("#status-filter").addEventListener("change",e=>{state.filter=e.target.value;renderOrders()});
  $("#order-search").addEventListener("input",e=>{state.query=e.target.value.trim().toLowerCase();renderOrders()});
  const receiptPaper=$("#admin-receipt-paper");
  if(receiptPaper)receiptPaper.addEventListener("change",()=>{
    state.receiptPaper=["58","80","a4"].includes(receiptPaper.value)?receiptPaper.value:"80";
    document.querySelectorAll(".thermal-print-link").forEach(link=>link.href=receiptLink(link.getAttribute("data-order-id")));
  });
  $("#order-date").addEventListener("change",e=>{
    if(!validOrderDate(e.target.value)){e.target.value=state.selectedDate;return}
    selectOrderDate(e.target.value,false);
  });
  $("#today-orders").addEventListener("click",()=>selectOrderDate(todayInWib(),true));
  $("#previous-order-date").addEventListener("click",()=>selectOrderDate(shiftOrderDate(state.selectedDate,-1),false));
  $("#next-order-date").addEventListener("click",()=>selectOrderDate(shiftOrderDate(state.selectedDate,1),false));
  $("#load-more-orders").addEventListener("click",()=>loadOrders(false,true));
  document.addEventListener("dapoer:admin-session-expired",showLogin);
  document.addEventListener("visibilitychange",()=>{if(!document.hidden&&$("#dashboard-view")&&!$("#dashboard-view").hidden)loadOrders(true)});
}

function setPasswordVisibility(visible,restoreFocus=false){
  const password=$("#admin-password"),button=$("#toggle-admin-password");
  if(!password||!button)return;
  const start=password.selectionStart,end=password.selectionEnd,direction=password.selectionDirection;
  password.type=visible?"text":"password";
  const label=visible?"Sembunyikan password":"Tampilkan password";
  button.setAttribute("aria-label",label);
  button.setAttribute("aria-pressed",String(visible));
  button.title=label;
  const eye=$("#admin-password-eye"),eyeOff=$("#admin-password-eye-off");
  if(eye)eye.hidden=visible;
  if(eyeOff)eyeOff.hidden=!visible;
  if(restoreFocus){
    password.focus({preventScroll:true});
    if(typeof start==="number"&&typeof end==="number")password.setSelectionRange(start,end,direction||"none");
  }
}

function updateDateControls(now=new Date()){
  const today=todayInWib(now);
  $("#order-date").value=state.selectedDate;
  $("#order-date").max=today;
  $("#next-order-date").disabled=state.selectedDate>=today;
  $("#today-orders").classList.toggle("active",state.followingToday&&state.selectedDate===today);
  $("#today-orders").setAttribute("aria-pressed",String(state.followingToday));
  $("#order-period").textContent=`${orderDateLabel(state.selectedDate)}${state.selectedDate===today?" · Hari ini":""} · WIB`;
  $("#overview").setAttribute("aria-label",`Ringkasan pesanan ${orderDateLabel(state.selectedDate)}`);
}
function cancelOrderRequest(){
  state.generation++;
  if(state.request)state.request.controller.abort();
  state.request=null;
}
function resetOrderDate(date,followingToday){
  cancelOrderRequest();
  state.selectedDate=date;
  state.followingToday=followingToday;
  state.orders=[];
  state.seenIds=new Set();
  state.initialized=false;
  state.pageCount=1;
  state.pagination=null;
  state.summary=null;
  $("#last-updated").textContent="—";
  updateDateControls();
  updateStats();
  renderOrders();
  updateLoadingControls();
}
function selectOrderDate(date,followingToday=false){
  if(!validOrderDate(date))return;
  if(date!==state.selectedDate)resetOrderDate(date,followingToday);
  else{state.followingToday=followingToday;updateDateControls()}
  return loadOrders(false);
}
function syncToday(now=new Date()){
  const today=todayInWib(now);
  if(state.followingToday&&state.selectedDate!==today){resetOrderDate(today,true);return true}
  updateDateControls(now);
  return false;
}

async function checkSession(){
  try{
    const res=await fetch("/api/admin/session",{headers:{Accept:"application/json"}});
    if(!res.ok)return showLogin();
    const data=await res.json();
    $("#admin-identity").textContent=data.email||"Admin";
    showDashboard();
    syncNotificationButton();
    await loadOrders(true);
    if(!$("#dashboard-view").hidden)startPolling();
  }catch{showLogin()}
}

function showLogin(){
  setPasswordVisibility(false);
  stopPolling();
  cancelOrderRequest();
  state.orders=[];
  state.seenIds=new Set();
  state.initialized=false;
  state.summary=null;
  state.pagination=null;
  state.pageCount=1;
  $("#orders-list").replaceChildren();
  $("#login-view").hidden=false;
  $("#dashboard-view").hidden=true;
  window.DapoerAdminAuthenticated=false;
  signalAdminEvent("dapoer:admin-session",{authenticated:false});
}
function showDashboard(){
  setPasswordVisibility(false);
  $("#login-view").hidden=true;$("#dashboard-view").hidden=false;
  window.DapoerAdminAuthenticated=true;
  signalAdminEvent("dapoer:admin-session",{authenticated:true});
}

async function login(e){
  e.preventDefault();
  const button=$("#login-button");
  const passwordToggle=$("#toggle-admin-password");
  setPasswordVisibility(false);
  if(passwordToggle)passwordToggle.disabled=true;
  button.disabled=true;
  button.textContent="Memeriksa akun…";
  $("#login-message").textContent="";
  try{
    const res=await fetch("/api/admin/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:$("#admin-email").value.trim(),password:$("#admin-password").value})});
    const data=await res.json();
    if(!res.ok)throw new Error(data.error||"Login gagal");
    $("#admin-password").value="";
    await checkSession();
  }catch(err){$("#login-message").textContent=err.message||"Login gagal."}
  finally{button.disabled=false;button.textContent="Masuk ke Dashboard";if(passwordToggle)passwordToggle.disabled=false}
}

async function logout(){
  showLogin();
  await fetch("/api/admin/logout",{method:"POST"});
}

function startPolling(){
  stopPolling();
  state.pollTimer=setInterval(()=>loadOrders(true),10000);
  scheduleDayRollover();
}
function scheduleDayRollover(){
  state.rolloverTimer=setTimeout(()=>{
    loadOrders(true);
    scheduleDayRollover();
  },millisecondsToWibMidnight()+50);
}
function stopPolling(){
  if(state.pollTimer){clearInterval(state.pollTimer);state.pollTimer=null}
  if(state.rolloverTimer){clearTimeout(state.rolloverTimer);state.rolloverTimer=null}
}
function hasMoreOrders(){
  return !!state.pagination&&state.pageCount<state.pagination.totalPages&&state.orders.length<state.pagination.total;
}
function updateLoadingControls(){
  const request=state.request;
  const refresh=$("#refresh-orders");
  refresh.disabled=!!request;
  refresh.textContent=request&&!request.silent&&!request.more?"↻ Memuat…":"↻ Refresh data";
  const more=$("#load-more-orders");
  more.hidden=!hasMoreOrders();
  more.disabled=!!request;
  more.textContent=request&&request.more?"Memuat pesanan…":"Muat pesanan berikutnya";
}
async function fetchOrderPage(date,page,request){
  const params=new URLSearchParams({date,page:String(page),pageSize:String(ORDER_PAGE_SIZE)});
  const res=await fetch(`/api/admin/orders?${params}`,{headers:{Accept:"application/json"},cache:"no-store",signal:request.controller.signal});
  const data=await res.json();
  if(state.request!==request||request.generation!==state.generation)return null;
  if(res.status===401){showLogin();return null}
  if(!res.ok)throw new Error(data.error||"Gagal memuat pesanan");
  if(data.date!==date||data.timeZone!==ORDER_TIME_ZONE||!data.pagination||!data.summary||!Array.isArray(data.orders)){
    throw new Error("Riwayat harian belum tersedia. Coba refresh setelah deployment selesai.");
  }
  return data;
}

async function loadOrders(silent=false,more=false){
  if(syncToday())more=false;
  // A visibility event, manual refresh, and poll share one active request.
  if(state.request||(more&&!hasMoreOrders()))return;
  const request={date:state.selectedDate,generation:state.generation,controller:new AbortController(),silent,more};
  state.request=request;
  updateLoadingControls();
  if(!silent)$("#orders-caption").textContent="Memuat data pesanan…";
  try{
    const initialSnapshot=state.initialized;
    const page=more?state.pageCount+1:1;
    const first=await fetchOrderPage(request.date,page,request);
    if(!first)return;
    const received=[...first.orders];
    let latest=first;
    let loadedPages=page;
    if(!more){
      // Retain every loaded page on refresh, including rows displaced by new orders.
      const pages=Math.min(state.pageCount,Math.max(1,Number(first.pagination.totalPages)));
      for(let next=2;next<=pages;next++){
        const data=await fetchOrderPage(request.date,next,request);
        if(!data)return;
        received.push(...data.orders);
        latest=data;
        loadedPages=next;
      }
    }
    if(state.request!==request||request.generation!==state.generation)return;
    const fresh=!more&&initialSnapshot&&request.date===todayInWib()
      ?first.orders.filter(order=>!state.seenIds.has(order.id)):[];
    state.orders=mergeOrders(state.orders,received);
    received.forEach(order=>state.seenIds.add(order.id));
    state.pageCount=loadedPages;
    state.summary=first.summary;
    state.pagination=latest.pagination;
    state.initialized=true;
    updateStats();
    renderOrders();
    $("#last-updated").textContent=new Date().toLocaleTimeString("id-ID",{timeZone:ORDER_TIME_ZONE,hour:"2-digit",minute:"2-digit"})+" WIB";
    if(fresh.length)notifyNewOrders(fresh);
  }catch(err){
    if(state.request!==request||err.name==="AbortError")return;
    if(!silent||!state.initialized){
      $("#orders-caption").textContent=err.message||"Pesanan belum dapat dimuat.";
      if(!state.orders.length)$("#orders-list").replaceChildren(makeEmpty("Data belum tersedia","Coba refresh data kembali."));
    }
  }finally{
    if(state.request===request){state.request=null;updateLoadingControls()}
  }
}

function updateStats(){
  const summary=state.summary||{};
  $("#stat-total").textContent=Number(summary.totalOrders||0);
  $("#stat-new").textContent=Number(summary.newOrders||0);
  $("#stat-processing").textContent=Number(summary.processingOrders||0);
  $("#stat-value").textContent=rupiah(summary.orderValue);
}

function filteredOrders(){
  return state.orders.filter(o=>{
    const statusOk=state.filter==="all"||o.status===state.filter;
    if(!statusOk)return false;
    if(!state.query)return true;
    const haystack=[o.id,orderQueueLabel(o.queue_number),o.queue_number,o.customer_name,o.customer_phone,o.address,o.payment_method,o.status].filter(Boolean).join(" ").toLowerCase();
    return haystack.includes(state.query);
  });
}

function orderQueueLabel(number){return Number.isSafeInteger(number)&&number>0?`A${String(number).padStart(3,"0")}`:""}
function receiptLink(id){return `/nota/?id=${encodeURIComponent(id)}&paper=${state.receiptPaper}`}

function renderOrders(){
  const root=$("#orders-list");
  root.replaceChildren();
  const rows=filteredOrders();
  const total=Number(state.summary?.totalOrders||0);
  $("#orders-caption").textContent=`${rows.length} ditampilkan · ${state.orders.length} dimuat dari ${total} pesanan pada tanggal ini${state.query||state.filter!=="all"?". Filter berlaku pada pesanan yang sudah dimuat.":"."}`;
  if(!rows.length){
    root.append(makeEmpty(total?"Tidak ada pesanan yang sesuai":"Belum ada pesanan pada tanggal ini",total?"Coba ubah pencarian atau filter, atau muat pesanan berikutnya.":"Pilih tanggal lain untuk melihat riwayat pesanan."));
    return;
  }
  rows.forEach(order=>root.append(makeOrderCard(order)));
}

function makeEmpty(title,text){
  const el=document.createElement("div");el.className="empty-state";
  const strong=document.createElement("strong");strong.textContent=title;
  const span=document.createElement("span");span.textContent=text;
  el.append(strong,span);return el;
}

function makeOrderCard(order){
  const card=document.createElement("article");card.className="order-card";

  const primary=document.createElement("div");primary.className="order-primary";
  const id=document.createElement("div");id.className="order-id";id.textContent=order.id;
  const time=document.createElement("div");time.className="order-time";
  time.textContent=new Date(order.created_at).toLocaleString("id-ID",{timeZone:ORDER_TIME_ZONE,dateStyle:"medium",timeStyle:"short"})+" WIB";
  primary.append(id,time);
  const queue=orderQueueLabel(order.queue_number);
  if(queue){const badge=document.createElement("div");badge.className="order-queue";badge.textContent=`Antrean ${queue}`;primary.append(badge)}

  const customer=document.createElement("div");customer.className="customer-cell";
  const name=document.createElement("div");name.className="customer-name";name.textContent=order.customer_name||"—";
  const phone=document.createElement("div");phone.className="customer-meta";phone.textContent=order.customer_phone||"—";
  const address=document.createElement("div");address.className="address-line";address.textContent=order.address||"—";
  const payment=document.createElement("div");payment.className="payment-line";payment.textContent=`Pembayaran: ${order.payment_method||"—"}`;
  customer.append(name,phone,address,payment);
  if(order.notes){
    const notes=document.createElement("div");notes.className="notes-line";notes.textContent=`Catatan: ${order.notes}`;
    customer.append(notes);
  }

  const items=document.createElement("div");items.className="items-cell";
  (Array.isArray(order.items)?order.items:[]).forEach(item=>{
    const row=document.createElement("p");row.className="item-line";
    const a=document.createElement("span");a.textContent=`${item.name} × ${item.quantity}`;
    const b=document.createElement("strong");b.textContent=rupiah(item.subtotal);
    row.append(a,b);items.append(row);
  });

  const total=document.createElement("div");total.className="order-total";total.textContent=rupiah(order.total);

  const statusCell=document.createElement("div");statusCell.className="status-cell";
  const badge=document.createElement("span");badge.className=`status-badge status-${order.status||"baru"}`;badge.textContent=order.status||"baru";
  const controls=document.createElement("div");controls.className="status-control";
  const select=document.createElement("select");
  ["baru","diproses","dikirim","selesai","dibatalkan"].forEach(s=>{
    const opt=document.createElement("option");opt.value=s;opt.textContent=s[0].toUpperCase()+s.slice(1);opt.selected=s===order.status;select.append(opt);
  });
  const button=document.createElement("button");button.type="button";button.textContent="Simpan";
  button.addEventListener("click",()=>changeStatus(order.id,select.value,button));
  controls.append(select,button);statusCell.append(badge,controls);
  const print=document.createElement("a");
  print.className="thermal-print-link";
  print.setAttribute("data-order-id",order.id);
  print.href=receiptLink(order.id);
  print.target="_blank";
  print.rel="noopener noreferrer";
  print.textContent="Cetak struk customer";
  print.setAttribute("aria-label",`Cetak struk ${queue?"antrean "+queue:order.id}`);
  primary.append(print);

  if(order.tracking_token){
    const tracking=document.createElement("a");
    tracking.className="tracking-link";
    tracking.href=`/track/?id=${encodeURIComponent(order.id)}&token=${encodeURIComponent(order.tracking_token)}`;
    tracking.target="_blank";
    tracking.rel="noopener";
    tracking.textContent="↗ Buka Tracking Customer";
    statusCell.append(tracking);
  }

  card.append(primary,customer,items,total,statusCell);
  return card;
}

async function changeStatus(id,status,button){
  button.disabled=true;
  const original=button.textContent;
  button.textContent="…";
  const selectedDate=state.selectedDate;
  try{
    const res=await fetch("/api/admin/status",{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({id,status})});
    const data=await res.json();
    if(!res.ok)throw new Error(data.error||"Gagal mengubah status");
    signalAdminEvent("dapoer:stock-changed",{orderId:id,status});
    if(selectedDate===state.selectedDate)cancelOrderRequest();
    const target=selectedDate===state.selectedDate?state.orders.find(o=>o.id===id):null;
    if(target){
      const previous=target.status;
      if(state.summary){
        state.summary.newOrders=Number(state.summary.newOrders)+(status==="baru"?1:0)-(previous==="baru"?1:0);
        state.summary.processingOrders=Number(state.summary.processingOrders)+(["diproses","dikirim"].includes(status)?1:0)-(["diproses","dikirim"].includes(previous)?1:0);
        state.summary.orderValue=Number(state.summary.orderValue)+(status!=="dibatalkan"?Number(target.total||0):0)-(previous!=="dibatalkan"?Number(target.total||0):0);
      }
      target.status=status;
      updateStats();renderOrders();
      await loadOrders(true);
    }
    showAdminToast("Status diperbarui",`${id} sekarang berstatus ${status}.`);
  }catch(err){alert(err.message||"Gagal mengubah status")}
  finally{button.disabled=false;button.textContent=original}
}

async function enableNotifications(){
  if(!("Notification" in window)){
    showAdminToast("Notifikasi browser tidak tersedia","Browser ini tidak mendukung notifikasi.");
    return;
  }
  const permission=await Notification.requestPermission();
  syncNotificationButton();
  if(permission==="granted")showAdminToast("Notifikasi aktif","Order baru akan memunculkan notifikasi browser.");
}

function syncNotificationButton(){
  const button=$("#enable-notifications");
  if(!button)return;
  if("Notification" in window&&Notification.permission==="granted"){
    button.textContent="🔔 Notifikasi aktif";
    button.classList.add("enabled");
  }else{
    button.textContent="🔔 Aktifkan notifikasi";
    button.classList.remove("enabled");
  }
}

function notifyNewOrders(orders){
  const latest=orders[0];
  const text=orders.length===1
    ? `${latest.customer_name||"Customer"} • ${latest.id} • ${rupiah(latest.total)}`
    : `${orders.length} pesanan baru masuk.`;
  showAdminToast("Pesanan baru masuk",text);
  playBeep();
  document.title="🔔 Pesanan Baru | Admin Dapoer Pasta";
  setTimeout(()=>{document.title="Admin Dapoer Pasta"},7000);
  if("Notification" in window&&Notification.permission==="granted"){
    new Notification("Pesanan baru Dapoer Pasta",{body:text,tag:latest.id});
  }
}

function showAdminToast(title,text){
  $("#notification-title").textContent=title;
  $("#notification-text").textContent=text;
  const box=$("#admin-notification");
  box.classList.add("show");
  clearTimeout(showAdminToast.timer);
  showAdminToast.timer=setTimeout(()=>box.classList.remove("show"),5500);
}

function playBeep(){
  try{
    const AudioCtx=window.AudioContext||window.webkitAudioContext;
    if(!AudioCtx)return;
    const ctx=new AudioCtx();
    const osc=ctx.createOscillator();
    const gain=ctx.createGain();
    osc.frequency.value=880;
    gain.gain.setValueAtTime(.07,ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(.001,ctx.currentTime+.28);
    osc.connect(gain);gain.connect(ctx.destination);
    osc.start();osc.stop(ctx.currentTime+.28);
  }catch{}
}

})();
