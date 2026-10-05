const state={orders:[],filter:"all"};
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
  $("#login-message").textContent="";
  try{
    const res=await fetch("/api/admin/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:$("#admin-email").value.trim(),password:$("#admin-password").value})});
    const data=await res.json();
    if(!res.ok)throw new Error(data.error||"Login gagal");
    $("#admin-password").value="";
    await checkSession();
  }catch(err){$("#login-message").textContent=err.message||"Login gagal."}
  finally{button.disabled=false}
}

async function logout(){
  await fetch("/api/admin/logout",{method:"POST"});
  state.orders=[];
  showLogin();
}

async function loadOrders(){
  $("#orders-caption").textContent="Memuat data…";
  try{
    const res=await fetch("/api/admin/orders",{headers:{Accept:"application/json"}});
    const data=await res.json();
    if(res.status===401)return showLogin();
    if(!res.ok)throw new Error(data.error||"Gagal memuat pesanan");
    state.orders=Array.isArray(data.orders)?data.orders:[];
    updateStats();
    renderOrders();
  }catch(err){
    $("#orders-caption").textContent=err.message||"Pesanan belum dapat dimuat.";
    $("#orders-list").replaceChildren(makeEmpty("Database belum siap atau terjadi gangguan."));
  }
}

function updateStats(){
  $("#stat-total").textContent=state.orders.length;
  $("#stat-new").textContent=state.orders.filter(o=>o.status==="baru").length;
  $("#stat-value").textContent=rupiah(state.orders.filter(o=>o.status!=="dibatalkan").reduce((s,o)=>s+Number(o.total||0),0));
}

function renderOrders(){
  const root=$("#orders-list");
  root.replaceChildren();
  const rows=state.filter==="all"?state.orders:state.orders.filter(o=>o.status===state.filter);
  $("#orders-caption").textContent=`${rows.length} pesanan ditampilkan`;
  if(!rows.length){root.append(makeEmpty("Belum ada pesanan pada filter ini."));return}
  rows.forEach(order=>root.append(makeOrderCard(order)));
}

function makeEmpty(text){const el=document.createElement("div");el.className="empty-state";el.textContent=text;return el}

function makeOrderCard(order){
  const card=document.createElement("article");card.className="order-card";
  const top=document.createElement("div");top.className="order-top";
  const left=document.createElement("div");
  const id=document.createElement("div");id.className="order-id";id.textContent=order.id;
  const time=document.createElement("div");time.className="order-time";time.textContent=new Date(order.created_at).toLocaleString("id-ID");
  left.append(id,time);
  const badge=document.createElement("span");badge.className="status-badge";badge.textContent=order.status;
  top.append(left,badge);

  const grid=document.createElement("div");grid.className="order-grid";
  const customer=document.createElement("div");customer.append(heading("Customer"),line(order.customer_name),line(order.customer_phone),line(order.address),line(order.payment_method),line(order.notes||""));
  const items=document.createElement("div");items.append(heading("Pesanan"));
  (Array.isArray(order.items)?order.items:[]).forEach(item=>{
    const row=document.createElement("p");row.className="item-line";
    const a=document.createElement("span");a.textContent=`${item.name} × ${item.quantity}`;
    const b=document.createElement("strong");b.textContent=rupiah(item.subtotal);
    row.append(a,b);items.append(row);
  });
  const action=document.createElement("div");action.append(heading("Total & Status"));
  const total=document.createElement("div");total.className="order-total";total.textContent=rupiah(order.total);action.append(total);
  const controls=document.createElement("div");controls.className="status-control";
  const select=document.createElement("select");
  ["baru","diproses","dikirim","selesai","dibatalkan"].forEach(s=>{const opt=document.createElement("option");opt.value=s;opt.textContent=s;opt.selected=s===order.status;select.append(opt)});
  const button=document.createElement("button");button.type="button";button.textContent="Simpan";button.addEventListener("click",()=>changeStatus(order.id,select.value,button));
  controls.append(select,button);action.append(controls);
  grid.append(customer,items,action);card.append(top,grid);return card;
}

function heading(text){const h=document.createElement("h3");h.textContent=text;return h}
function line(text){const p=document.createElement("p");p.textContent=text||"—";return p}

async function changeStatus(id,status,button){
  button.disabled=true;
  try{
    const res=await fetch("/api/admin/status",{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({id,status})});
    const data=await res.json();
    if(!res.ok)throw new Error(data.error||"Gagal mengubah status");
    const target=state.orders.find(o=>o.id===id);if(target)target.status=status;
    updateStats();renderOrders();
  }catch(err){alert(err.message||"Gagal mengubah status")}
  finally{button.disabled=false}
}
