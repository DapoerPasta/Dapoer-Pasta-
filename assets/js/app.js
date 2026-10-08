const state={menu:[],store:null,cart:loadCart(),menuReady:false,menuRequest:null};
const $=s=>document.querySelector(s);
const rupiah=v=>`Rp ${Number(v).toLocaleString("id-ID")}`;
document.addEventListener("DOMContentLoaded",init);

async function init(){
  bindUI(); observeReveal(); renderCart();
  await loadMenu();
  setInterval(()=>{if(!document.hidden)loadMenu()},15000);
  document.addEventListener("visibilitychange",()=>{if(!document.hidden)loadMenu()});
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
  $("#open-chat")?.addEventListener("click",()=>$("#chat-box")?.classList.toggle("open"));
  $("#close-chat")?.addEventListener("click",()=>$("#chat-box")?.classList.remove("open"));
  $("#chat-form")?.addEventListener("submit",sendChat);
}

async function loadMenu(){
  if(state.menuRequest)return state.menuRequest;
  state.menuRequest=fetchMenu();
  try{return await state.menuRequest}finally{state.menuRequest=null}
}

async function fetchMenu(){
  const root=$("#menu-grid");
  try{
    const res=await fetch("/api/menu",{cache:"no-store",headers:{Accept:"application/json"}});
    if(!res.ok)throw new Error("menu");
    const data=await res.json();
    if(!Array.isArray(data.products))throw new Error("menu");
    state.menu=data.products; state.store=data.store||null; state.menuReady=true;
    renderMenu(); renderCart(); return true;
  }catch{
    state.menuReady=false;
    root.replaceChildren();
    const el=document.createElement("div");
    el.className="menu-loading";
    el.textContent="Menu dan stok belum dapat dimuat. Silakan coba lagi atau hubungi WhatsApp Dapoer Pasta.";
    root.append(el);
    renderCart(); return false;
  }
}

function renderMenu(){
  const root=$("#menu-grid"); root.replaceChildren();
  state.menu.forEach((p,i)=>{
    const card=document.createElement("article"); card.className="product-card reveal show";
    card.setAttribute("data-motion-key",`product:${p.id}`);
    const media=document.createElement("div"); media.className="product-image";
    const img=document.createElement("img"); img.src=p.image; img.alt=p.name; img.loading="lazy"; img.decoding="async";
    const badge=document.createElement("span"); badge.className="product-badge"; badge.textContent=p.badge;
    const price=document.createElement("span"); price.className="product-price"; price.textContent=rupiah(p.price);
    media.append(img,badge,price);

    const body=document.createElement("div"); body.className="product-body";
    const idx=document.createElement("div"); idx.className="product-index"; idx.textContent=String(i+1).padStart(2,"0")+".";
    const title=document.createElement("h3"); title.textContent=p.name;
    const desc=document.createElement("p"); desc.textContent=p.description;
    const stock=document.createElement("div"); stock.className="product-stock";
    stock.textContent=p.stock>0?`Stok tersedia: ${p.stock}`:"Stok habis";
    if(p.stock===0)stock.classList.add("sold-out");
    const action=document.createElement("div"); action.className="product-action";
    const add=document.createElement("button"); add.className="add-button"; add.type="button";
    add.innerHTML='Tambah ke keranjang <i class="fa-solid fa-arrow-right" aria-hidden="true"></i>';
    add.disabled=!Number.isSafeInteger(p.stock)||p.stock<=0;
    if(add.disabled)add.textContent="Stok habis";
    add.addEventListener("click",()=>addToCart(p.id));
    const mark=document.createElement("span"); mark.className="small-mark"; mark.textContent="DP";
    action.append(add,mark); body.append(idx,title,desc,stock,action); card.append(media,body); root.append(card);
  });
  window.DapoerMotion?.reveal(root);
}

function addToCart(id){
  const p=state.menu.find(x=>x.id===id); if(!p)return;
  const found=state.cart.find(x=>x.id===id);
  const available=stockFor(id);
  if(available===null){showToast("Stok belum dapat diperiksa. Silakan coba lagi.");return}
  if((found?.quantity||0)>=available){showToast(available?`Stok ${p.name} tersisa ${available}.`:"Stok produk habis.");return}
  if(found)found.quantity++; else state.cart.push({id:p.id,name:p.name,price:p.price,quantity:1});
  persistCart(); renderCart(); showToast(`${p.name} ditambahkan.`);
}
function updateQuantity(id,delta){
  const item=state.cart.find(x=>x.id===id); if(!item)return;
  if(delta>0){
    const available=stockFor(id);
    if(available===null||item.quantity+delta>available){showToast(available===null?"Stok belum dapat diperiksa.":`Stok ${item.name} tersisa ${available}.`);return}
  }
  item.quantity+=delta; if(item.quantity<=0)state.cart=state.cart.filter(x=>x.id!==id);
  persistCart(); renderCart();
}
function removeCartItem(id){state.cart=state.cart.filter(x=>x.id!==id);persistCart();renderCart()}

function renderCart(){
  const root=$("#cart-items"); if(!root)return;
  $("#cart-count").textContent=state.cart.reduce((s,x)=>s+x.quantity,0);
  const checkout=$("#checkout-button");
  if(checkout)checkout.disabled=!state.cart.length||!cartStockAvailable();
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
    const available=stockFor(item.id);
    const meta=document.createElement("small");
    meta.textContent=`${rupiah(item.price)} / item · ${available===null?"Stok belum dapat diperiksa":`Stok: ${available}`}`;
    if(available!==null&&item.quantity>available){meta.className="cart-stock-error";meta.textContent+=available===0?" · Hapus produk yang habis":" · Kurangi jumlah pesanan"}
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
    plus.disabled=available===null||item.quantity>=available;
    qty.append(minus,value,plus);
    const sub=document.createElement("div"); sub.className="subtotal"; sub.textContent=rupiah(subtotal);
    foot.append(qty,sub); row.append(head,foot); root.append(row);
  });
  $("#cart-total").textContent=rupiah(total);
}

function loadCart(){try{const raw=localStorage.getItem("dapoer-pasta-cart");const p=raw?JSON.parse(raw):[];return Array.isArray(p)?p:[]}catch{return[]}}
function persistCart(){localStorage.setItem("dapoer-pasta-cart",JSON.stringify(state.cart))}
function stockFor(id){
  const p=state.menu.find(x=>x.id===id);
  return state.menuReady&&Number.isSafeInteger(p?.stock)&&p.stock>=0?p.stock:null;
}
function cartStockAvailable(){return state.cart.every(item=>{const available=stockFor(item.id);return available!==null&&item.quantity>0&&item.quantity<=available})}
function toggleCart(open){$("#cart-overlay")?.classList.toggle("open",open);$("#cart-overlay")?.setAttribute("aria-hidden",String(!open));document.body.classList.toggle("no-scroll",open)}

function cartTotal(){return state.cart.reduce((sum,item)=>sum+(item.price*item.quantity),0)}
function toggleCheckout(open){$("#checkout-modal")?.classList.toggle("open",open);$("#checkout-modal")?.setAttribute("aria-hidden",String(!open));document.body.classList.toggle("no-scroll",open)}
async function openCheckout(){
  if(!state.cart.length){showToast("Pilih menu terlebih dahulu.");toggleCart(true);return}
  await loadMenu();
  if(!cartStockAvailable()){showToast("Periksa stok terbaru dan sesuaikan jumlah di keranjang.");toggleCart(true);return}
  $("#checkout-total").textContent=rupiah(cartTotal());toggleCart(false);toggleCheckout(true);setTimeout(()=>$("#checkout-name")?.focus(),80);
}
async function submitCheckout(e){
  e.preventDefault();
  if(!state.cart.length){showToast("Keranjang kosong.");toggleCheckout(false);return}

  const button=$("#checkout-submit");
  const originalLabel=button?.innerHTML;
  if(button){
    button.disabled=true;
    button.innerHTML='<i class="fa-solid fa-spinner fa-spin"></i> Memvalidasi pesanan…';
  }

  try{
    await loadMenu();
    if(!cartStockAvailable())throw new Error("Stok berubah. Sesuaikan jumlah di keranjang sebelum memesan.");
    const items=state.cart.map(item=>({id:item.id,quantity:item.quantity}));
    const customer={name:$("#checkout-name").value.trim(),phone:$("#checkout-phone").value.trim(),address:$("#checkout-address").value.trim(),paymentMethod:$("#checkout-payment").value,notes:$("#checkout-notes").value.trim()};
    const res=await fetch("/api/order",{
      method:"POST",
      headers:{"Content-Type":"application/json",Accept:"application/json"},
      body:JSON.stringify({items,customer})
    });
    const data=await res.json();

    if(res.status===409&&data.code==="INSUFFICIENT_STOCK"){
      await loadMenu();
      toggleCheckout(false);toggleCart(true);
      showToast(data.error||"Stok tidak mencukupi. Sesuaikan jumlah di keranjang.");
      return;
    }

    if(res.status===429){
      showToast(data.error||"Terlalu banyak permintaan. Silakan coba lagi nanti.");
      return;
    }

    if(!res.ok||!data.whatsappUrl){
      throw new Error(data.error||"Pesanan tidak valid");
    }

    if(data.order?.items){
      state.cart=data.order.items.map(item=>({
        id:item.id,
        name:item.name,
        price:item.price,
        quantity:item.quantity
      }));
      persistCart();
      renderCart();
    }

    const orderId=data.order?.id||"";
    state.cart=[];persistCart();renderCart();$("#checkout-form")?.reset();toggleCheckout(false);
    const trackingUrl=data.trackingUrl||"";
    if(trackingUrl)localStorage.setItem("dapoer-pasta-last-tracking",trackingUrl);
    showToast(orderId?`Pesanan ${orderId} tersimpan.`:"Pesanan tersimpan.");
    window.open(data.whatsappUrl,"_blank","noopener,noreferrer");
    if(trackingUrl)setTimeout(()=>{window.location.href=trackingUrl},250);
  }catch(error){
    showToast(error.message||"Pesanan belum dapat disimpan. Periksa data lalu coba lagi.");
  }finally{
    if(button){
      button.disabled=false;
      button.innerHTML=originalLabel;
    }
  }
}

function toggleMobileMenu(open){$("#mobile-menu")?.classList.toggle("open",open);$("#mobile-menu")?.setAttribute("aria-hidden",String(!open));$("#mobile-menu-button")?.setAttribute("aria-expanded",String(open));document.body.classList.toggle("no-scroll",open)}

async function sendChat(e){
  e.preventDefault(); const input=$("#chat-input"); const message=input.value.trim(); if(!message)return;
  addChatMessage(message,"user-message"); input.value="";
  const pending=addChatMessage("Concierge sedang menyiapkan jawaban…","bot-message");
  try{
    const res=await fetch("/api/chat",{method:"POST",headers:{"Content-Type":"application/json",Accept:"application/json"},body:JSON.stringify({message})});
    const data=await res.json(); pending.textContent=data.reply||"Maaf, saya belum dapat menjawab. Silakan hubungi WhatsApp Dapoer Pasta.";
  }catch{pending.textContent="Maaf, asisten sedang sibuk. Silakan hubungi WhatsApp Dapoer Pasta."}
}
function addChatMessage(text,className){const el=document.createElement("div");el.className=`chat-message ${className}`;el.textContent=text;$("#chat-messages").append(el);el.scrollIntoView({behavior:"smooth",block:"end"});return el}
function showToast(message){$("#toast-message").textContent=message;$("#toast").classList.add("show");clearTimeout(showToast.timer);showToast.timer=setTimeout(()=>$("#toast").classList.remove("show"),2300)}
function observeReveal(){
  if(window.DapoerMotion){window.DapoerMotion.reveal();return}
  if(typeof IntersectionObserver!=="function"){
    document.querySelectorAll(".reveal").forEach(el=>el.classList.add("show"));return;
  }
  const obs=new IntersectionObserver(entries=>entries.forEach(e=>{if(e.isIntersecting){e.target.classList.add("show");obs.unobserve(e.target)}}),{threshold:.1});
  document.querySelectorAll(".reveal").forEach(el=>obs.observe(el));
}
