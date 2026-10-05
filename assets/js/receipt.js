const $=s=>document.querySelector(s);
const rupiah=v=>`Rp ${Number(v||0).toLocaleString("id-ID")}`;

document.addEventListener("DOMContentLoaded",()=>{
  $("#print-receipt").addEventListener("click",()=>window.print());
  loadReceipt();
});

async function loadReceipt(){
  const params=new URLSearchParams(location.search);
  const id=params.get("id")||"";
  const token=params.get("token")||"";
  if(!id||!token)return fail("Link nota tidak valid.");

  $("#back-tracking").href=`/track/?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`;

  try{
    const res=await fetch(`/api/receipt?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`,{headers:{Accept:"application/json"},cache:"no-store"});
    const data=await res.json();
    if(!res.ok)throw new Error(data.error||"Nota belum tersedia.");
    render(data.order);
  }catch(err){fail(err.message||"Nota belum dapat dimuat.")}
}

function render(order){
  $("#receipt-id").textContent=order.id;
  $("#receipt-customer").textContent=order.customerName||"—";
  $("#receipt-date").textContent=new Date(order.createdAt).toLocaleString("id-ID");
  $("#receipt-status").textContent=label(order.status);
  $("#receipt-total").textContent=rupiah(order.total);
  $("#receipt-method").textContent=order.paymentMethod||"—";
  $("#receipt-phone").textContent=order.customerPhone||"—";
  $("#receipt-address").textContent=order.address||"—";
  $("#receipt-notes").textContent=order.notes||"Tidak ada";

  const root=$("#receipt-items");root.replaceChildren();
  (Array.isArray(order.items)?order.items:[]).forEach(item=>{
    const row=document.createElement("div");row.className="receipt-item";
    const left=document.createElement("div");
    const name=document.createElement("span");name.textContent=item.name;
    const meta=document.createElement("small");meta.textContent=`${item.quantity} × ${rupiah(item.price)}`;
    const total=document.createElement("strong");total.textContent=rupiah(item.subtotal);
    left.append(name,meta);row.append(left,total);root.append(row);
  });

  $("#receipt-loading").hidden=true;
}

function label(status){
  const labels={baru:"Pesanan Diterima",diproses:"Diproses",dikirim:"Dikirim",selesai:"Selesai",dibatalkan:"Dibatalkan"};
  return labels[status]||status||"—";
}

function fail(message){
  $("#receipt-loading").hidden=true;
  $("#receipt-error").hidden=false;
  $("#receipt-error").textContent=message;
}