const $=s=>document.querySelector(s);
const rupiah=v=>`Rp ${Number(v||0).toLocaleString("id-ID")}`;
const statusOrder=["baru","diproses","dikirim","selesai"];
let lastStatus=null;
let timer=null;

document.addEventListener("DOMContentLoaded",()=>{
  loadStatus();
  timer=setInterval(loadStatus,8000);
  document.addEventListener("visibilitychange",()=>{if(!document.hidden)loadStatus()});
});

async function loadStatus(){
  const params=new URLSearchParams(location.search);
  const id=params.get("id")||"";
  const token=params.get("token")||"";
  if(!id||!token)return showError("Link tracking tidak valid.");

  try{
    const res=await fetch(`/api/track?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`,{headers:{Accept:"application/json"},cache:"no-store"});
    const data=await res.json();
    if(!res.ok)throw new Error(data.error||"Status pesanan belum tersedia.");
    render(data.order);
  }catch(err){showError(err.message||"Status pesanan belum dapat dimuat.")}
}

function render(order){
  $("#track-loading").hidden=true;
  $("#track-error").hidden=true;
  $("#track-content").hidden=false;
  $("#track-order-id").textContent=order.id;
  const queue=Number.isSafeInteger(order.queueNumber)&&order.queueNumber>0?`A${String(order.queueNumber).padStart(3,"0")}`:"";
  $("#track-queue").hidden=!queue;
  $("#track-queue-number").textContent=queue||"—";
  const queueDate=typeof order.queueDate==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(order.queueDate)?new Date(`${order.queueDate}T00:00:00Z`):null;
  $("#track-queue-date").textContent=queueDate&&Number.isFinite(queueDate.getTime())?queueDate.toLocaleDateString("id-ID",{timeZone:"UTC",day:"numeric",month:"long",year:"numeric"})+" · WIB":"";
  $("#track-total").textContent=rupiah(order.total);
  $("#track-status").textContent=order.status;
  $("#track-updated").textContent=`Diperbarui ${new Date(order.updatedAt).toLocaleString("id-ID",{timeZone:"Asia/Jakarta"})} WIB`;

  const params=new URLSearchParams(location.search);
  const id=params.get("id")||"";
  const token=params.get("token")||"";
  const receiptUrl=`${location.origin}/nota/?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`;
  $("#receipt-link").href=receiptUrl;
  const qrRoot=$("#receipt-qr");
  if(qrRoot&&!qrRoot.dataset.ready&&window.QRCode){
    qrRoot.dataset.ready="1";
    new QRCode(qrRoot,{text:receiptUrl,width:168,height:168,correctLevel:QRCode.CorrectLevel.M});
  }

  const currentIndex=statusOrder.indexOf(order.status);
  document.querySelectorAll(".step").forEach((step,i)=>{
    step.classList.toggle("done",currentIndex>=0&&i<currentIndex);
    step.classList.toggle("active",currentIndex>=0&&i===currentIndex);
  });
  $("#cancelled-note").hidden=order.status!=="dibatalkan";

  const root=$("#track-items");root.replaceChildren();
  (Array.isArray(order.items)?order.items:[]).forEach(item=>{
    const row=document.createElement("div");row.className="track-item";
    const name=document.createElement("span");name.textContent=`${item.name} × ${item.quantity}`;
    const sub=document.createElement("strong");sub.textContent=rupiah(item.subtotal);
    row.append(name,sub);root.append(row);
  });

  if(lastStatus&&lastStatus!==order.status){
    document.title=`Status: ${order.status} | Dapoer Pasta`;
  }
  lastStatus=order.status;
}

function showError(message){
  $("#track-loading").hidden=true;
  $("#track-content").hidden=true;
  $("#track-error").hidden=false;
  $("#track-error").textContent=message;
}
