const state={menu:[],store:null,cart:loadCart()};
const $=s=>document.querySelector(s);
const rupiah=v=>`Rp ${Number(v).toLocaleString("id-ID")}`;
document.addEventListener("DOMContentLoaded",init);

async function init(){
  bindUI(); observeReveal(); renderCart();
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
  $("#checkout-button")?.addEventListener("click",checkoutWhatsApp);
  $("#open-chat")?.addEventListener("click",()=>$("#chat-box")?.classList.toggle("open"));
  $("#close-chat")?.addEventListener("click",()=>$("#chat-box")?.classList.remove("open"));
  $("#chat-form")?.addEventListener("submit",sendChat);
}

async function loadMenu(){
  const root=$("#menu-grid");
  try{
    const res=await fetch("/.netlify/functions/menu",{headers:{Accept:"application/json"}});
    if(!res.ok)throw new Error("menu");
    const data=await res.json();
    state.menu=data.products||[]; state.store=data.store||null; renderMenu();
  }catch{
    root.replaceChildren();
    const el=document.createElement("div");
    el.className="menu-loading";
    el.textContent="Menu belum dapat dimuat. Silakan pesan langsung melalui WhatsApp Dapoer Pasta.";
    root.append(el);
  }
}

function renderMenu(){
  const root=$("#menu-grid"); root.replaceChildren();
  state.menu.forEach((p,i)=>{
    const card=document.createElement("article"); card.className="product-card reveal show";
    const media=document.createElement("div"); media.className="product-image";
    const img=document.createElement("img"); img.src=p.image; img.alt=p.name; img.loading="lazy"; img.decoding="async";
    const badge=document.createElement("span"); badge.className="product-badge"; badge.textContent=p.badge;
    const price=document.createElement("span"); price.className="product-price"; price.textContent=rupiah(p.price);
    media.append(img,badge,price);

    const body=document.createElement("div"); body.className="product-body";
    const idx=document.createElement("div"); idx.className="product-index"; idx.textContent=String(i+1).padStart(2,"0")+".";
    const title=document.createElement("h3"); title.textContent=p.name;
    const desc=document.createElement("p"); desc.textContent=p.description;
    const action=document.createElement("div"); action.className="product-action";
    const add=document.createElement("button"); add.className="add-button"; add.type="button";
    add.innerHTML='Tambah ke keranjang <i class="fa-solid fa-arrow-right" aria-hidden="true"></i>';
    add.addEventListener("click",()=>addToCart(p.id));
    const mark=document.createElement("span"); mark.className="small-mark"; mark.textContent="DP";
    action.append(add,mark); body.append(idx,title,desc,action); card.append(media,body); root.append(card);
  });
}

function addToCart(id){
  const p=state.menu.find(x=>x.id===id); if(!p)return;
  const found=state.cart.find(x=>x.id===id);
  if(found)found.quantity++; else state.cart.push({id:p.id,name:p.name,price:p.price,quantity:1});
  persistCart(); renderCart(); showToast(`${p.name} ditambahkan.`);
}
function updateQuantity(id,delta){
  const item=state.cart.find(x=>x.id===id); if(!item)return;
  item.quantity+=delta; if(item.quantity<=0)state.cart=state.cart.filter(x=>x.id!==id);
  persistCart(); renderCart();
}
function removeCartItem(id){state.cart=state.cart.filter(x=>x.id!==id);persistCart();renderCart()}

function renderCart(){
  const root=$("#cart-items"); if(!root)return;
  $("#cart-count").textContent=state.cart.reduce((s,x)=>s+x.quantity,0);
  root.replaceChildren();
  if(!state.cart.length){
    const empty=document.createElement("div"); empty.className="empty-cart";
    empty.innerHTML='<i class="fa-solid fa-bag-shopping" aria-hidden="true"></i><p>Keranjang masih kosong.</p>';
    root.append(empty); $("#cart-total").textContent=rupiah(0); return;
  }
  let total=0;
  state.cart.forEach(item=>{
    const subtotal=item.price*item.quantity; total+=subtotal;
    const row=document.createElement("div"); row.className="cart-item";
    const head=document.createElement("div"); head.className="cart-item-head";
    const info=document.createElement("div");
    const title=document.createElement("h3"); title.textContent=item.name;
    const meta=document.createElement("small"); meta.textContent=`${rupiah(item.price)} / item`;
    info.append(title,meta);
    const remove=document.createElement("button"); remove.type="button"; remove.className="cart-remove";
    remove.setAttribute("aria-label",`Hapus ${item.name}`);
    remove.innerHTML='<i class="fa-solid fa-trash" aria-hidden="true"></i>';
    remove.addEventListener("click",()=>removeCartItem(item.id));
    head.append(info,remove);

    const foot=document.createElement("div"); foot.className="cart-row";
    const qty=document.createElement("div"); qty.className="quantity";
    const minus=document.createElement("button"); minus.type="button"; minus.textContent="−"; minus.addEventListener("click",()=>updateQuantity(item.id,-1));
    const value=document.createElement("span"); value.textContent=item.quantity;
    const plus=document.createElement("button"); plus.type="button"; plus.textContent="+"; plus.addEventListener("click",()=>updateQuantity(item.id,1));
    qty.append(minus,value,plus);
    const sub=document.createElement("div"); sub.className="subtotal"; sub.textContent=rupiah(subtotal);
    foot.append(qty,sub); row.append(head,foot); root.append(row);
  });
  $("#cart-total").textContent=rupiah(total);
}

function loadCart(){try{const raw=localStorage.getItem("dapoer-pasta-cart");const p=raw?JSON.parse(raw):[];return Array.isArray(p)?p:[]}catch{return[]}}
function persistCart(){localStorage.setItem("dapoer-pasta-cart",JSON.stringify(state.cart))}
function toggleCart(open){$("#cart-overlay")?.classList.toggle("open",open);$("#cart-overlay")?.setAttribute("aria-hidden",String(!open));document.body.classList.toggle("no-scroll",open)}

function checkoutWhatsApp(){
  if(!state.cart.length){showToast("Pilih menu terlebih dahulu.");toggleCart(true);return}
  const phone=state.store?.whatsapp||"6285175391181";
  const total=state.cart.reduce((s,x)=>s+x.price*x.quantity,0);
  const lines=["Halo Admin Dapoer Pasta, saya mau pesan:",""];
  state.cart.forEach((x,i)=>{lines.push(`${i+1}. *${x.name}*`,`Jumlah: ${x.quantity}`,`Subtotal: ${rupiah(x.price*x.quantity)}`,"")});
  lines.push(`*TOTAL PESANAN: ${rupiah(total)}*`,"","Nama Pemesan:","Alamat Pengiriman:","Metode Pembayaran: (OVO / ShopeePay / DANA)","","_Mohon info ongkirnya ya kak._");
  window.open(`https://api.whatsapp.com/send?phone=${phone}&text=${encodeURIComponent(lines.join("\n"))}`,"_blank","noopener,noreferrer");
}

function toggleMobileMenu(open){$("#mobile-menu")?.classList.toggle("open",open);$("#mobile-menu")?.setAttribute("aria-hidden",String(!open));$("#mobile-menu-button")?.setAttribute("aria-expanded",String(open));document.body.classList.toggle("no-scroll",open)}

async function sendChat(e){
  e.preventDefault(); const input=$("#chat-input"); const message=input.value.trim(); if(!message)return;
  addChatMessage(message,"user-message"); input.value="";
  const pending=addChatMessage("Concierge sedang menyiapkan jawaban…","bot-message");
  try{
    const res=await fetch("/.netlify/functions/chat",{method:"POST",headers:{"Content-Type":"application/json",Accept:"application/json"},body:JSON.stringify({message})});
    const data=await res.json(); pending.textContent=data.reply||"Maaf, saya belum dapat menjawab. Silakan hubungi WhatsApp Dapoer Pasta.";
  }catch{pending.textContent="Maaf, asisten sedang sibuk. Silakan hubungi WhatsApp Dapoer Pasta."}
}
function addChatMessage(text,className){const el=document.createElement("div");el.className=`chat-message ${className}`;el.textContent=text;$("#chat-messages").append(el);el.scrollIntoView({behavior:"smooth",block:"end"});return el}
function showToast(message){$("#toast-message").textContent=message;$("#toast").classList.add("show");clearTimeout(showToast.timer);showToast.timer=setTimeout(()=>$("#toast").classList.remove("show"),2300)}
function observeReveal(){const obs=new IntersectionObserver(entries=>entries.forEach(e=>{if(e.isIntersecting){e.target.classList.add("show");obs.unobserve(e.target)}}),{threshold:.1});document.querySelectorAll(".reveal").forEach(el=>obs.observe(el))}
