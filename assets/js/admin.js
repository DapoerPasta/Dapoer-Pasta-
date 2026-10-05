const state={orders:[],filter:"all",query:""};
const $=s=>document.querySelector(s);
const rupiah=v=>`Rp ${Number(v||0).toLocaleString("id-ID")}`;

document.addEventListener("DOMContentLoaded",init);

async function init(){
  bind();
  await checkSession();
}

function bind(){
  $("#login-form").addEventListener("submit",login);
  $("#logout-button").addEventListener("click",logout);
  $("#refresh-orders").addEventListener("click",loadOrders);
  $("#status-filter").addEventListener("change",e=>{state.filter=e.target.value;renderOrders()});
  $("#order-search").addEventListener("input",e=>{state.query=e.target.value.trim().toLowerCase();renderOrders()});
}

async function checkSession(){
  try{
    const res=await fetch("/api/admin/session",{headers:{Accept:"application/json"}});
    if(!res.ok)return showLogin();
    const data=await res.json();
    $("#admin-identity").textContent=data.email||"Admin";
    showDashboard();
    await loadOrders();
  }catch{showLogin()}
}

function showLogin(){$("#login-view").hidden=false;$("#dashboard-view").hidden=true}
function showDashboard(){$("#login-view").hidden=true;$("#dashboard-view").hidden=false}

async function login(e){
  e.preventDefault();
  const button=$("#login-button");
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
  finally{button.disabled=false;button.textContent="Masuk ke Dashboard"}
}

async function logout(){
  await fetch("/api/admin/logout",{method:"POST"});
  state.orders=[];
  showLogin();
}

async function loadOrders(){
  $("#orders-caption").textContent="Memuat data pesanan…";
  const refresh=$("#refresh-orders");
  refresh.disabled=true;
  refresh.textContent="↻ Memuat…";
  try{
    const res=await fetch("/api/admin/orders",{headers:{Accept:"application/json"}});
    const data=await res.json();
    if(res.status===401)return showLogin();
    if(!res.ok)throw new Error(data.error||"Gagal memuat pesanan");
    state.orders=Array.isArray(data.orders)?data.orders:[];
    updateStats();
    renderOrders();
    $("#last-updated").textContent=new Date().toLocaleTimeString("id-ID",{hour:"2-digit",minute:"2-digit"});
  }catch(err){
    $("#orders-caption").textContent=err.message||"Pesanan belum dapat dimuat.";
    $("#orders-list").replaceChildren(makeEmpty("Data belum tersedia","Database belum siap atau terjadi gangguan."));
  }finally{
    refresh.disabled=false;
    refresh.textContent="↻ Refresh data";
  }
}

function updateStats(){
  $("#stat-total").textContent=state.orders.length;
  $("#stat-new").textContent=state.orders.filter(o=>o.status==="baru").length;
  $("#stat-processing").textContent=state.orders.filter(o=>["diproses","dikirim"].includes(o.status)).length;
  $("#stat-value").textContent=rupiah(state.orders.filter(o=>o.status!=="dibatalkan").reduce((s,o)=>s+Number(o.total||0),0));
}

function filteredOrders(){
  return state.orders.filter(o=>{
    const statusOk=state.filter==="all"||o.status===state.filter;
    if(!statusOk)return false;
    if(!state.query)return true;
    const haystack=[o.id,o.customer_name,o.customer_phone,o.address,o.payment_method,o.status]
      .filter(Boolean).join(" ").toLowerCase();
    return haystack.includes(state.query);
  });
}

function renderOrders(){
  const root=$("#orders-list");
  root.replaceChildren();
  const rows=filteredOrders();
  $("#orders-caption").textContent=`${rows.length} dari ${state.orders.length} pesanan ditampilkan`;
  if(!rows.length){
    root.append(makeEmpty("Tidak ada pesanan","Coba ubah kata pencarian atau filter status."));
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
  time.textContent=new Date(order.created_at).toLocaleString("id-ID",{dateStyle:"medium",timeStyle:"short"});
  primary.append(id,time);

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

  card.append(primary,customer,items,total,statusCell);
  return card;
}

async function changeStatus(id,status,button){
  button.disabled=true;
  const original=button.textContent;
  button.textContent="…";
  try{
    const res=await fetch("/api/admin/status",{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({id,status})});
    const data=await res.json();
    if(!res.ok)throw new Error(data.error||"Gagal mengubah status");
    const target=state.orders.find(o=>o.id===id);if(target)target.status=status;
    updateStats();renderOrders();
  }catch(err){alert(err.message||"Gagal mengubah status")}
  finally{button.disabled=false;button.textContent=original}
}
