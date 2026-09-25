const state={menu:null,cart:loadCart()};
const rupiah=n=>new Intl.NumberFormat("id-ID",{style:"currency",currency:"IDR",maximumFractionDigits:0}).format(n);
const $=s=>document.querySelector(s);

document.addEventListener("DOMContentLoaded",init);

async function init(){
  try{
    const res=await fetch("/data/menu.json",{cache:"no-cache"});
    if(!res.ok) throw new Error("Menu gagal dimuat");
    state.menu=await res.json();
    renderMenu();
    renderCart();
    bindUI();
  }catch(err){
    $("#menu-grid").textContent="Maaf, menu belum dapat dimuat. Silakan pesan melalui WhatsApp.";
  }
}

function bindUI(){
  $("#open-cart").addEventListener("click",()=>toggleCart(true));\n  $("#open-cart-fab").addEventListener("click",()=>toggleCart(true));
  $("#close-cart").addEventListener("click",()=>toggleCart(false));
  $("#cart-overlay").addEventListener("click",e=>{if(e.target.id==="cart-overlay")toggleCart(false)});
  $("#checkout").addEventListener("click",checkoutWhatsApp);
  $("#open-chat").addEventListener("click",()=>$("#chat-panel").classList.toggle("open"));
  $("#close-chat").addEventListener("click",()=>$("#chat-panel").classList.remove("open"));
  $("#chat-form").addEventListener("submit",sendChat);
}

function renderMenu(){
  const root=$("#menu-grid");
  root.replaceChildren();
  for(const product of state.menu.products){
    const card=document.createElement("article");
    card.className="card";
    card.innerHTML=`<div class="card-media"><img loading="lazy" decoding="async"></div>
      <div class="card-body"><span class="badge"></span><h3></h3><p></p>
      <div class="card-foot"><span class="price"></span><button class="add-btn" type="button">Tambah</button></div></div>`;
    const img=card.querySelector("img"); img.src=product.image; img.alt=product.name;
    card.querySelector(".badge").textContent=product.badge;
    card.querySelector("h3").textContent=product.name;
    card.querySelector("p").textContent=product.description;
    card.querySelector(".price").textContent=rupiah(product.price);
    card.querySelector(".add-btn").addEventListener("click",()=>addToCart(product.id));
    root.append(card);
  }
}

function addToCart(id){
  const p=state.menu.products.find(x=>x.id===id); if(!p)return;
  const found=state.cart.find(x=>x.id===id);
  if(found) found.qty+=1; else state.cart.push({id:p.id,name:p.name,price:p.price,qty:1});
  persistCart(); renderCart();
}

function changeQty(id,delta){
  const item=state.cart.find(x=>x.id===id); if(!item)return;
  item.qty+=delta;
  if(item.qty<=0) state.cart=state.cart.filter(x=>x.id!==id);
  persistCart(); renderCart();
}

function renderCart(){
  const root=$("#cart-items"); const count=state.cart.reduce((a,b)=>a+b.qty,0);
  $("#cart-count").textContent=count;
  root.replaceChildren();
  if(!state.cart.length){
    const empty=document.createElement("div");empty.className="cart-empty";empty.textContent="Keranjang masih kosong.";root.append(empty);
    $("#cart-total").textContent=rupiah(0);return;
  }
  let total=0;
  for(const item of state.cart){
    total+=item.price*item.qty;
    const row=document.createElement("div");row.className="cart-row-item";
    const top=document.createElement("div");top.className="cart-row-top";
    const info=document.createElement("div");
    const title=document.createElement("strong");title.textContent=item.name;
    const price=document.createElement("div");price.className="muted";price.textContent=`${rupiah(item.price)} / item`;
    info.append(title,price);
    const subtotal=document.createElement("strong");subtotal.textContent=rupiah(item.price*item.qty);
    top.append(info,subtotal);
    const controls=document.createElement("div");controls.className="qty-row";
    const qty=document.createElement("div");qty.className="qty";
    const minus=document.createElement("button");minus.type="button";minus.textContent="−";minus.addEventListener("click",()=>changeQty(item.id,-1));
    const amount=document.createElement("span");amount.textContent=item.qty;
    const plus=document.createElement("button");plus.type="button";plus.textContent="+";plus.addEventListener("click",()=>changeQty(item.id,1));
    qty.append(minus,amount,plus);
    const remove=document.createElement("button");remove.type="button";remove.className="icon-btn";remove.style.color="#8e403a";remove.textContent="Hapus";remove.addEventListener("click",()=>{state.cart=state.cart.filter(x=>x.id!==item.id);persistCart();renderCart()});
    controls.append(qty,remove);row.append(top,controls);root.append(row);
  }
  $("#cart-total").textContent=rupiah(total);
}

function loadCart(){
  try{const raw=localStorage.getItem("dapoer-cart");return raw?JSON.parse(raw):[]}catch{return []}
}
function persistCart(){localStorage.setItem("dapoer-cart",JSON.stringify(state.cart))}
function toggleCart(open){$("#cart-overlay").classList.toggle("open",open);document.body.style.overflow=open?"hidden":""}

function checkoutWhatsApp(){
  if(!state.cart.length){toggleCart(true);return}
  const total=state.cart.reduce((s,x)=>s+x.price*x.qty,0);
  const lines=["Halo Admin Dapoer Pasta, saya mau pesan:","",...state.cart.flatMap((x,i)=>[
    `${i+1}. *${x.name}*`,`Jumlah: ${x.qty}`,`Subtotal: ${rupiah(x.price*x.qty)}`,""
  ]),`*TOTAL PESANAN: ${rupiah(total)}*`,"","Nama Pemesan:","Alamat Pengiriman:","Metode Pembayaran: (OVO / ShopeePay / DANA)","","Mohon info ongkirnya ya kak."];
  const url=`https://api.whatsapp.com/send?phone=${state.menu.store.whatsapp}&text=${encodeURIComponent(lines.join("\n"))}`;
  window.open(url,"_blank","noopener,noreferrer");
}

async function sendChat(event){
  event.preventDefault();
  const input=$("#chat-input"); const message=input.value.trim();
  if(!message)return;
  addMessage(message,"user"); input.value="";
  const pending=addMessage("Sedang menyiapkan jawaban…","bot");
  try{
    const res=await fetch("/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({message})});
    const data=await res.json();
    pending.textContent=data.reply||"Maaf, layanan chat belum tersedia.";
  }catch{
    pending.textContent="Maaf, chat sedang tidak tersedia. Silakan hubungi WhatsApp Dapoer Pasta.";
  }
}
function addMessage(text,type){
  const el=document.createElement("div");el.className=`msg ${type}`;el.textContent=text;
  $("#chat-messages").append(el);el.scrollIntoView({behavior:"smooth",block:"end"});return el;
}
