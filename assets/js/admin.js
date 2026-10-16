(()=>{
const ORDER_TIME_ZONE="Asia/Jakarta";
const ORDER_PAGE_SIZE=100;
const STATUS_FLOW=["baru","diproses","dikirim","selesai"];
const state={cards:new Map(),drafts:new Map(),pendingStatuses:new Map(),additionReviews:new Map(),additionNotices:new Map(),sessionGeneration:0,lastSuccess:0,readError:null,logoutPending:false,cancelConfirmation:null,orders:[],filter:"all",query:"",receiptPaper:"80",initialized:false,pollTimer:null,rolloverTimer:null,selectedDate:todayInWib(),followingToday:true,pageCount:1,pagination:null,summary:null,seenIds:new Set(),generation:0,request:null};
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
  window.DapoerAdminSession?.subscribe(()=>showLogin());
  const cancelDialog=$("#order-cancel-dialog");
  if(cancelDialog){
    $("#order-cancel-back").addEventListener("click",()=>finishCancellation(false));
    $("#order-cancel-confirm").addEventListener("click",()=>finishCancellation(true));
    cancelDialog.addEventListener("cancel",event=>{event.preventDefault();finishCancellation(false)});
  }
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
  document.addEventListener("dapoer:admin-session-expired",expireSession);
  document.addEventListener("visibilitychange",()=>{updateLiveState();if(!document.hidden&&$("#dashboard-view")&&!$("#dashboard-view").hidden)loadOrders(true)});
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
  state.cards.clear();
  state.lastSuccess=0;state.readError=null;
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
  const generation=state.sessionGeneration;
  try{
    const res=await fetch("/api/admin/session",{headers:{Accept:"application/json"}});
    if(generation!==state.sessionGeneration)return;
    if(res.status===401)return expireSession();
    if(!res.ok)return showLogin();
    const data=await res.json();
    if(generation!==state.sessionGeneration)return;
    $("#admin-identity").textContent=data.email||"Admin";
    showDashboard();
    syncNotificationButton();
    await loadOrders(true);
    if(!$("#dashboard-view").hidden)startPolling();
  }catch{if(generation===state.sessionGeneration)showLogin()}
}

function expireSession(){
  window.DapoerAdminSession?.notifyLogout("expired");
  showLogin();
}
function showLogin(){
  state.sessionGeneration++;
  state.additionReviews.forEach(review=>review.controller?.abort());
  state.additionReviews.clear();state.additionNotices.clear();
  state.pendingStatuses.clear();state.drafts.clear();state.cards.clear();
  finishCancellation(false);
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
  sessionMessage("");
}

async function login(e){
  e.preventDefault();
  const generation=state.sessionGeneration;
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
    if(generation!==state.sessionGeneration)return;
    if(!res.ok)throw new Error(data.error||"Login gagal");
    $("#admin-password").value="";
    await checkSession();
  }catch(err){$("#login-message").textContent=err.message||"Login gagal."}
  finally{button.disabled=false;button.textContent="Masuk ke Dashboard";if(passwordToggle)passwordToggle.disabled=false}
}

function sessionMessage(text){
  const node=$("#admin-session-message");if(!node)return;
  node.textContent=text;node.hidden=!text;
}
async function logout(){
  if(state.logoutPending)return;
  state.logoutPending=true;
  const button=$("#logout-button");button.disabled=true;button.textContent="Keluar…";
  sessionMessage("");
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),30000);
  try{
    const res=await fetch("/api/admin/logout",{method:"POST",headers:{Accept:"application/json"},cache:"no-store",signal:controller.signal});
    if(!res.ok)throw new Error("Keluar belum berhasil. Sesi Anda masih aktif. Tekan Keluar untuk mencoba lagi.");
    window.DapoerAdminSession?.notifyLogout("logout");
    showLogin();
  }catch{
    sessionMessage("Keluar belum berhasil karena koneksi atau server. Sesi Anda masih aktif. Tekan Keluar untuk mencoba lagi.");
  }finally{clearTimeout(timeout);state.logoutPending=false;button.disabled=false;button.textContent="Keluar"}
}

function startPolling(){
  stopPolling();
  state.pollTimer=setInterval(()=>{updateLiveState();if(!document.hidden)loadOrders(true)},10000);
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
  updateLiveState();
  $("#orders-list").setAttribute("aria-busy",String(!!request));
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
  if(state.request!==request||request.generation!==state.generation)return null;
  if(res.status===401){expireSession();return null}
  const data=await res.json();
  if(state.request!==request||request.generation!==state.generation)return null;
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
    reconcileAdditionReviews(received);
    received.forEach(order=>state.seenIds.add(order.id));
    state.pageCount=loadedPages;
    state.summary=first.summary;
    state.pagination=latest.pagination;
    state.initialized=true;
    state.lastSuccess=Date.now();state.readError=null;
    updateLiveState();
    updateStats();
    renderOrders();
    $("#last-updated").textContent=new Date().toLocaleTimeString("id-ID",{timeZone:ORDER_TIME_ZONE,hour:"2-digit",minute:"2-digit"})+" WIB";
    if(fresh.length)notifyNewOrders(fresh);
  }catch(err){
    if(state.request!==request||err.name==="AbortError")return;
    state.readError=["SyntaxError","TypeError"].includes(err.name)?"Koneksi belum tersedia. Tekan Refresh data untuk mencoba lagi.":err.message||"Koneksi belum tersedia";
    updateLiveState();
    if(!silent||!state.initialized){
      $("#orders-caption").textContent=state.readError;
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

function updateLiveState(){
  const pill=$("#orders-live-state"),label=$("#orders-live-label");if(!pill||!label)return;
  const age=state.lastSuccess?Math.max(0,Date.now()-state.lastSuccess):0;
  const delayed=!!state.readError||age>30000;
  pill.classList.toggle("delayed",delayed);pill.classList.toggle("paused",!!document.hidden);
  pill.classList.toggle("connecting",!state.lastSuccess&&!state.readError);
  label.textContent=state.readError?"Koneksi terganggu · mencoba lagi":document.hidden?"Pembaruan dijeda":!state.lastSuccess?"Menghubungkan…":age>30000?`Data terakhir ${Math.max(1,Math.floor(age/60000))} menit lalu`:"Data tersambung · setiap 10 detik";
  pill.title=state.readError?`${state.readError}. Data terakhir tetap ditampilkan; tekan Refresh data untuk mencoba lagi.`:"Data pesanan diperbarui setiap 10 detik saat halaman aktif.";
}
function renderOrders(){
  const root=$("#orders-list");
  const rows=filteredOrders();
  const total=Number(state.summary?.totalOrders||0);
  $("#orders-caption").textContent=`${rows.length} ditampilkan · ${state.orders.length} dimuat dari ${total} pesanan pada tanggal ini${state.query||state.filter!=="all"?". Filter berlaku pada pesanan yang sudah dimuat.":"."}`;
  if(!rows.length){
    root.replaceChildren(makeEmpty(total?"Tidak ada pesanan yang sesuai":"Belum ada pesanan pada tanggal ini",total?"Coba ubah pencarian atau filter, atau muat pesanan berikutnya.":"Pilih tanggal lain untuk melihat riwayat pesanan."));
    return;
  }
  const visible=new Set(rows.map(order=>order.id));
  Array.from(root.children).forEach(node=>{if(!visible.has(node.getAttribute?.("data-order-id")))node.remove?.()});
  rows.forEach((order,index)=>{
    let row=state.cards.get(order.id);
    if(!row){makeOrderCard(order);row=state.cards.get(order.id)}
    updateOrderContents(order,row);
    updateStatusRow(order,row);
    if(root.children[index]!==row.card){
      if(typeof root.insertBefore==="function")root.insertBefore(row.card,root.children[index]||null);
      else root.append(row.card);
    }
  });
}
function allowedStatus(current,next){
  if(current===next)return true;
  if(next==="dibatalkan")return ["baru","diproses"].includes(current);
  return current!=="dibatalkan"&&STATUS_FLOW.includes(current)&&STATUS_FLOW.indexOf(next)>STATUS_FLOW.indexOf(current);
}
function chooseStatus(id,value){
  const order=state.orders.find(order=>order.id===id);if(!order||state.pendingStatuses.has(id)||hasAdditionReview(id)||state.drafts.get(id)?.uncertain)return;
  if(value===order.status)state.drafts.delete(id);
  else{
    const draft=state.drafts.get(id);
    state.drafts.set(id,{value,expectedStatus:draft?.expectedStatus||order.status,expectedUpdatedAt:draft?.expectedUpdatedAt||order.updated_at,conflicted:!!draft?.conflicted});
  }
  updateStatusRow(order,state.cards.get(id));
}
function updateStatusRow(order,row){
  if(!row)return;
  const draft=state.drafts.get(order.id),pending=state.pendingStatuses.get(order.id),reviewing=hasAdditionReview(order.id);
  row.badge.className=`status-badge status-${order.status||"baru"}`;row.badge.textContent=order.status||"baru";
  const changed=!!draft&&(draft.expectedStatus!==order.status||draft.expectedUpdatedAt!==order.updated_at);
  if(changed&&!pending&&!draft.uncertain)draft.conflicted=true;
  row.select.value=draft?.value||order.status;
  Array.from(row.select.children).forEach(option=>option.disabled=!allowedStatus(order.status,option.value)&&option.value!==draft?.value);
  row.select.disabled=!!pending||reviewing||!!draft?.uncertain||!!draft?.conflicted||["selesai","dibatalkan"].includes(order.status);
  row.button.disabled=!!pending||reviewing||!!draft?.conflicted||!(draft?allowedStatus(draft.expectedStatus,draft.value):false);
  row.button.textContent=pending?pending.phase==="confirmation"?"Konfirmasi…":"Menyimpan…":"Simpan";
  row.message.textContent=draft?.conflicted?"Status sudah berubah. Periksa status terbaru sebelum menyimpan.":pending?pending.phase==="confirmation"?"Menunggu konfirmasi pembatalan…":"Perubahan sedang disimpan…":reviewing?"Selesaikan pemeriksaan tambahan sebelum mengubah status.":draft?.uncertain?"Hasil belum terkonfirmasi. Simpan lagi untuk memeriksa perubahan yang sama.":draft?"Pilihan belum disimpan.":["selesai","dibatalkan"].includes(order.status)?"Status akhir.":"";
  row.message.classList.toggle("error",!!draft?.conflicted);
  row.review.hidden=!draft?.conflicted;
  if(row.additions)updateAdditionRequests(order,row);
}

function makeEmpty(title,text){
  const el=document.createElement("div");el.className="empty-state";
  const strong=document.createElement("strong");strong.textContent=title;
  const span=document.createElement("span");span.textContent=text;
  el.append(strong,span);return el;
}

function makeOrderCard(order){
  const card=document.createElement("article");card.className="order-card";card.setAttribute("data-order-id",order.id);

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
  select.setAttribute("aria-label",`Status pesanan ${order.id}`);
  select.addEventListener("change",()=>chooseStatus(order.id,select.value));
  button.addEventListener("click",()=>changeStatus(order.id,select.value,button));
  const message=document.createElement("p");message.className="order-status-message";message.setAttribute("role","status");
  const review=document.createElement("button");review.type="button";review.className="order-status-review";review.textContent="Gunakan status terbaru";review.hidden=true;
  review.addEventListener("click",()=>{state.drafts.delete(order.id);const latest=state.orders.find(item=>item.id===order.id);if(latest)updateStatusRow(latest,state.cards.get(order.id))});
  controls.append(select,button);statusCell.append(badge,controls,message,review);
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

  const additions=document.createElement("section");additions.className="order-additions";additions.hidden=true;
  additions.setAttribute("aria-label",`Tambahan pesanan ${order.id}`);
  card.append(primary,customer,items,total,statusCell,additions);
  state.cards.set(order.id,{card,badge,select,button,message,review,items,total,additions,additionRows:new Map(),contentKey:null});
  return card;
}

function hasAdditionReview(id){return Array.from(state.additionReviews.values()).some(review=>review.orderId===id)}
function orderVersion(value){
  if(typeof value!=="string")return null;
  const milliseconds=Date.parse(value);if(!Number.isFinite(milliseconds))return null;
  const fraction=value.match(/\.(\d+)/)?.[1]||"";
  return BigInt(milliseconds)*1000n+BigInt(fraction.padEnd(6,"0").slice(3,6));
}
function reconcileAdditionReviews(orders){
  orders.forEach(order=>{
    state.additionReviews.forEach((review,id)=>{
      if(review.orderId!==order.id||review.controller)return;
      const addition=order.additions?.find(item=>item.id===id);
      if(addition&&addition.status!=="pending"||["dikirim","selesai","dibatalkan"].includes(order.status)){
        state.additionReviews.delete(id);state.additionNotices.delete(id);
      }
    });
  });
}
function updateOrderContents(order,row){
  if(!row)return;
  const items=Array.isArray(order.items)?order.items:[];
  const contentKey=JSON.stringify([items,order.total]);
  if(contentKey!==row.contentKey){
    row.items.replaceChildren();
    items.forEach(item=>{
      const line=document.createElement("p");line.className="item-line";
      const name=document.createElement("span");name.textContent=`${item.name} × ${item.quantity}`;
      const total=document.createElement("strong");total.textContent=rupiah(item.subtotal);
      line.append(name,total);row.items.append(line);
    });
    row.total.textContent=rupiah(order.total);row.contentKey=contentKey;
  }
  updateAdditionRequests(order,row);
}
function makeAdditionRequest(order,addition){
  const root=document.createElement("div");root.className="order-addition-request";root.setAttribute("data-addition-id",addition.id);
  const title=document.createElement("strong");title.className="order-addition-title";title.textContent="Permintaan tambahan menu";
  const items=document.createElement("div");items.className="order-addition-items";
  const totals=document.createElement("p");totals.className="order-addition-totals";
  const message=document.createElement("p");message.className="order-addition-message";message.setAttribute("role","status");message.setAttribute("aria-live","polite");
  const controls=document.createElement("div");controls.className="order-addition-actions";
  const approve=document.createElement("button");approve.type="button";approve.className="order-addition-approve";approve.textContent="Setujui tambahan";
  const reject=document.createElement("button");reject.type="button";reject.className="order-addition-reject";reject.textContent="Tolak";
  approve.setAttribute("aria-label",`Setujui tambahan untuk ${order.id}`);reject.setAttribute("aria-label",`Tolak tambahan untuk ${order.id}`);
  approve.addEventListener("click",()=>reviewAddition(order.id,addition.id,"approve"));
  reject.addEventListener("click",()=>reviewAddition(order.id,addition.id,"reject"));
  controls.append(approve,reject);root.append(title,items,totals,message,controls);
  return {root,items,totals,message,approve,reject,contentKey:null};
}
function updateAdditionRequests(order,row){
  const requests=(Array.isArray(order.additions)?order.additions:[]).filter(addition=>addition.status==="pending"&&order.status==="diproses");
  const visible=new Set(requests.map(addition=>addition.id));
  row.additionRows.forEach((entry,id)=>{if(!visible.has(id)){entry.root.remove?.();row.additionRows.delete(id)}});
  row.additions.hidden=!requests.length;
  requests.forEach(addition=>{
    let entry=row.additionRows.get(addition.id);
    if(!entry){entry=makeAdditionRequest(order,addition);row.additionRows.set(addition.id,entry);row.additions.append(entry.root)}
    const key=JSON.stringify([addition.items,addition.total,order.total]);
    if(key!==entry.contentKey){
      entry.items.replaceChildren();
      (Array.isArray(addition.items)?addition.items:[]).forEach(item=>{
        const line=document.createElement("p");line.className="item-line";
        const name=document.createElement("span");name.textContent=`${item.name} × ${item.quantity}`;
        const total=document.createElement("strong");total.textContent=rupiah(item.subtotal);
        line.append(name,total);entry.items.append(line);
      });
      entry.totals.textContent=`Tambahan ${rupiah(addition.total)} · Total jika disetujui ${rupiah(Number(order.total||0)+Number(addition.total||0))}`;
      entry.contentKey=key;
    }
    const mutation=state.additionReviews.get(addition.id);
    const busy=!!mutation?.controller;
    const blocked=!!state.pendingStatuses.get(order.id)||Array.from(state.additionReviews.values()).some(review=>review.orderId===order.id&&review.additionId!==addition.id);
    entry.approve.disabled=busy||blocked||!!mutation&&mutation.decision!=="approve";
    entry.reject.disabled=busy||blocked||!!mutation&&mutation.decision!=="reject";
    entry.approve.textContent=busy&&mutation.decision==="approve"?"Menyetujui…":mutation?.uncertain&&mutation.decision==="approve"?"Periksa persetujuan":"Setujui tambahan";
    entry.reject.textContent=busy&&mutation.decision==="reject"?"Menolak…":mutation?.uncertain&&mutation.decision==="reject"?"Periksa penolakan":"Tolak";
    const notice=state.additionNotices.get(addition.id);
    entry.message.textContent=busy?"Memeriksa stok dan menyimpan keputusan…":mutation?.uncertain?"Hasil belum terkonfirmasi. Tekan Periksa untuk memeriksa keputusan yang sama; tambahan tidak digandakan.":notice||"Stok dan total pesanan berubah setelah disetujui. Penolakan tidak mengubah pesanan.";
    entry.message.classList.toggle("error",!!notice||!!mutation?.uncertain);
  });
}
function additionErrorMessage(code,fallback){
  const messages={ORDER_CONFLICT:"Pesanan berubah. Data terbaru dimuat; periksa kembali sebelum mengambil keputusan.",ADDITION_NOT_ALLOWED:"Pesanan sudah tidak menerima tambahan. Data terbaru dimuat.",ADDITION_ALREADY_REVIEWED:"Tambahan ini sudah diputuskan. Data terbaru dimuat.",INSUFFICIENT_STOCK:"Stok tidak mencukupi. Tambahan belum disetujui; periksa stok atau tolak permintaan ini.",PRICE_CHANGED:"Harga menu berubah. Tambahan belum disetujui; minta customer mengirim tambahan dengan harga terbaru.",REQUEST_CONFLICT:"Keputusan untuk permintaan ini sudah berubah. Data terbaru dimuat.",ADDITION_NOT_FOUND:"Permintaan tambahan tidak ditemukan. Data terbaru dimuat."};
  return messages[code]||fallback||"Tambahan belum dapat diperiksa. Coba lagi.";
}
async function reviewAddition(id,additionId,decision){
  const order=state.orders.find(item=>item.id===id);
  const addition=order?.additions?.find(item=>item.id===additionId);
  if(!order||order.status!=="diproses"||!addition||addition.status!=="pending"||state.pendingStatuses.has(id))return;
  let mutation=state.additionReviews.get(additionId);
  if(mutation?.controller||mutation&&mutation.decision!==decision||Array.from(state.additionReviews.values()).some(review=>review.orderId===id&&review.additionId!==additionId))return;
  if(!mutation){
    if(!order.updated_at||!globalThis.crypto?.randomUUID){showAdminToast("Periksa data terbaru","Refresh halaman sebelum memeriksa tambahan.");return}
    mutation={orderId:id,additionId,decision,sessionGeneration:state.sessionGeneration,date:state.selectedDate,body:{action:"review-addition",id,additionId,decision,requestId:crypto.randomUUID(),expectedStatus:order.status,expectedUpdatedAt:order.updated_at}};
    state.additionReviews.set(additionId,mutation);
  }
  state.additionNotices.delete(additionId);
  mutation.controller=new AbortController();mutation.uncertain=false;
  updateAdditionRequests(order,state.cards.get(id));updateStatusRow(order,state.cards.get(id));
  let timeout;
  try{
    const result=await Promise.race([
      (async()=>{
        const res=await fetch("/api/admin/orders",{method:"POST",headers:{"Content-Type":"application/json",Accept:"application/json"},cache:"no-store",body:JSON.stringify(mutation.body),signal:mutation.controller.signal});
        if(mutation.sessionGeneration!==state.sessionGeneration)return null;
        if(res.status===401){expireSession();return null}
        return {res,data:await res.json()};
      })(),
      new Promise((_,reject)=>{timeout=setTimeout(()=>{mutation.controller?.abort();const error=new Error("Batas waktu konfirmasi terlampaui.");error.name="AbortError";reject(error)},30000)})
    ]);
    if(!result)return;
    const {res,data}=result;
    if(mutation.sessionGeneration!==state.sessionGeneration)return;
    if(!res.ok){
      if(res.status>=500)throw new Error(data.error||"Server belum mengonfirmasi keputusan.");
      const message=additionErrorMessage(data.code,data.error);
      state.additionReviews.delete(additionId);state.additionNotices.set(additionId,message);
      if(mutation.date===state.selectedDate){cancelOrderRequest();await loadOrders(true)}
      if(mutation.sessionGeneration!==state.sessionGeneration)return;
      showAdminToast("Periksa tambahan",message);return;
    }
    if(!data.addition||data.addition.id!==additionId||data.addition.status!==(decision==="approve"?"approved":"rejected")||!data.order||data.order.id!==id||!Array.isArray(data.order.items)||!Number.isSafeInteger(data.order.total)||data.order.total<=0||typeof data.order.updatedAt!=="string"||!Number.isFinite(Date.parse(data.order.updatedAt))||!["baru","diproses","dikirim","selesai","dibatalkan"].includes(data.order.status))throw new Error("Jawaban server belum lengkap. Periksa kembali keputusan yang sama.");
    state.additionReviews.delete(additionId);state.additionNotices.delete(additionId);
    if(mutation.date===state.selectedDate){
      const target=state.orders.find(item=>item.id===id);
      const incomingVersion=orderVersion(data.order.updatedAt),currentVersion=orderVersion(target?.updated_at);
      if(target&&(currentVersion===null||incomingVersion>=currentVersion)){
        const previousTotal=Number(target.total||0);
        if(Array.isArray(data.order.items))target.items=data.order.items;
        if(Number.isSafeInteger(data.order.total)&&data.order.total>0)target.total=data.order.total;
        if(typeof data.order.updatedAt==="string")target.updated_at=data.order.updatedAt;
        if(typeof data.order.status==="string")target.status=data.order.status;
        if(Array.isArray(data.order.additions))target.additions=data.order.additions;
        else target.additions=target.additions.map(item=>item.id===additionId?data.addition:item);
        if(state.summary&&target.status!=="dibatalkan")state.summary.orderValue=Number(state.summary.orderValue||0)+Number(target.total||0)-previousTotal;
        updateStats();renderOrders();
      }
    }
    signalAdminEvent("dapoer:stock-changed",{orderId:id,source:"order-addition",additionId});
    if(mutation.date===state.selectedDate){cancelOrderRequest();await loadOrders(true)}
    if(mutation.sessionGeneration!==state.sessionGeneration)return;
    showAdminToast(data.addition.status==="approved"?"Tambahan disetujui":"Tambahan ditolak",data.addition.status==="approved"?`${id} diperbarui dengan menu tambahan. Nomor antrean tetap sama.`:`${id} tetap menggunakan pesanan sebelumnya.`);
  }catch(error){
    if(mutation.sessionGeneration!==state.sessionGeneration)return;
    mutation.uncertain=true;
    showAdminToast("Hasil belum terkonfirmasi",error.name==="AbortError"?"Koneksi melewati batas waktu. Periksa keputusan yang sama tanpa mengirim ulang tambahan.":error.message||"Periksa koneksi dan coba lagi.");
  }finally{
    clearTimeout(timeout);mutation.controller=null;
    if(mutation.sessionGeneration===state.sessionGeneration){const latest=state.orders.find(item=>item.id===id);const row=state.cards.get(id);if(latest&&row){updateAdditionRequests(latest,row);updateStatusRow(latest,row)}}
  }
}

function finishCancellation(confirmed){
  const pending=state.cancelConfirmation;if(!pending)return;
  state.cancelConfirmation=null;
  const dialog=$("#order-cancel-dialog");if(dialog?.open)dialog.close();
  pending.resolve(confirmed);
}
function confirmCancellation(order){
  const dialog=$("#order-cancel-dialog");
  if(!dialog||typeof dialog.showModal!=="function")return Promise.resolve(false);
  $("#order-cancel-description").textContent=`${order.id} · ${order.customer_name||"Customer"} · ${rupiah(order.total)}`;
  return new Promise(resolve=>{
    finishCancellation(false);
    state.cancelConfirmation={resolve};dialog.showModal();$("#order-cancel-back").focus();
  });
}
async function changeStatus(id,status,button){
  if(state.pendingStatuses.has(id)||hasAdditionReview(id))return;
  const order=state.orders.find(item=>item.id===id);if(!order)return;
  if(!state.drafts.has(id)&&status!==order.status)chooseStatus(id,status);
  const draft=state.drafts.get(id);
  if(!draft||draft.value!==status||draft.conflicted||!allowedStatus(draft.expectedStatus,status))return;
  if(!draft.expectedUpdatedAt){showAdminToast("Periksa data terbaru","Refresh data pesanan sebelum menyimpan status.");return}
  const mutation={status,sessionGeneration:state.sessionGeneration,phase:status==="dibatalkan"?"confirmation":"saving"};
  state.pendingStatuses.set(id,mutation);button.disabled=true;
  updateStatusRow(order,state.cards.get(id));
  const selectedDate=state.selectedDate;
  let timeout;
  try{
    if(status==="dibatalkan"&&!draft.cancellationConfirmed){if(!await confirmCancellation(order))return;draft.cancellationConfirmed=true;}
    if(mutation.sessionGeneration!==state.sessionGeneration)return;
    mutation.phase="saving";updateStatusRow(order,state.cards.get(id));
    const controller=new AbortController();timeout=setTimeout(()=>controller.abort(),30000);
    const res=await fetch("/api/admin/status",{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({id,status,expectedStatus:draft.expectedStatus,expectedUpdatedAt:draft.expectedUpdatedAt}),signal:controller.signal});
    if(mutation.sessionGeneration!==state.sessionGeneration)return;
    if(res.status===401){expireSession();return}
    const data=await res.json();
    if(mutation.sessionGeneration!==state.sessionGeneration)return;
    if(!res.ok){
      if(res.status===409){draft.conflicted=true;if(selectedDate===state.selectedDate){cancelOrderRequest();await loadOrders(true)}}
      throw new Error(data.error||"Status belum dapat disimpan. Coba lagi dengan pilihan yang sama.");
    }
    state.drafts.delete(id);
    signalAdminEvent("dapoer:stock-changed",{orderId:id,status});
    if(selectedDate===state.selectedDate)cancelOrderRequest();
    const target=selectedDate===state.selectedDate?state.orders.find(item=>item.id===id):null;
    if(target){
      const previous=target.status;
      if(state.summary){
        state.summary.newOrders=Number(state.summary.newOrders)+(status==="baru"?1:0)-(previous==="baru"?1:0);
        state.summary.processingOrders=Number(state.summary.processingOrders)+(["diproses","dikirim"].includes(status)?1:0)-(["diproses","dikirim"].includes(previous)?1:0);
        state.summary.orderValue=Number(state.summary.orderValue)+(status!=="dibatalkan"?Number(target.total||0):0)-(previous!=="dibatalkan"?Number(target.total||0):0);
      }
      Object.assign(target,data.order||{status});
      updateStats();renderOrders();await loadOrders(true);
    }
    showAdminToast("Status diperbarui",`${id} sekarang berstatus ${status}.`);
  }catch(err){
    if(!draft.conflicted)draft.uncertain=true;
    if(mutation.sessionGeneration===state.sessionGeneration)showAdminToast(draft.conflicted?"Periksa status terbaru":"Hasil belum terkonfirmasi",err.message||"Periksa koneksi dan coba lagi.");
  }finally{
    if(timeout)clearTimeout(timeout);
    if(state.pendingStatuses.get(id)===mutation)state.pendingStatuses.delete(id);
    const latest=state.orders.find(item=>item.id===id);if(latest)updateStatusRow(latest,state.cards.get(id));
    button.disabled=false;
    if(latest&&state.cards.get(id)?.button===button)updateStatusRow(latest,state.cards.get(id));
  }
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
