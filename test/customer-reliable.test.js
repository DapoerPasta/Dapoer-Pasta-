const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const { webcrypto } = require("node:crypto");

const ID="chicken-pop-corn-250gr",TOKEN="a".repeat(48);
const product=(stock=20,price=37000)=>({id:ID,name:"Chicken pop corn 250gr",price,stock,image:"/assets/images/menu/chicken-pop-corn-1200.webp",imageFallback:"/8.png",imageSrcset:"/assets/images/menu/chicken-pop-corn-720.webp 720w, /assets/images/menu/chicken-pop-corn-1200.webp 1200w",imageWidth:1200,imageHeight:1698,badge:"Casa",description:"Ayam"});
const reply=(data,status=200)=>({ok:status>=200&&status<300,status,json:async()=>data});
const success=(payload,id="DP-TEST-001")=>reply({order:{id,items:payload.items,total:payload.expectedTotal,queueNumber:7,queueDate:"2026-10-14"},trackingUrl:`/track/?id=${id}&token=${TOKEN}`,whatsappUrl:"https://api.whatsapp.com/send?phone=6285175391181&text=Konfirmasi"});
function storage(map,fail=false,failWrites=false){return{getItem(key){if(fail)throw new Error("denied");return map.get(key)||null},setItem(key,value){if(fail||failWrites)throw new Error("denied");map.set(key,String(value))},removeItem(key){if(fail||failWrites)throw new Error("denied");map.delete(key)}}}
function customer(fetch,{local=new Map(),session=new Map(),failStorage=false,failWrites=false}={}){
  const elements=new Map(),opened=[],events=new Map(),timeouts=new Map(),intervals=[],location={origin:"https://example.com"},document={hidden:false,activeElement:null,addEventListener(type,fn){events.set(`document:${type}`,fn)},querySelectorAll(){return[]}};
  function node(){const classes=new Set(),listeners=new Map();return{children:[],value:"",textContent:"",hidden:false,disabled:false,isConnected:true,inert:false,validationMessage:"",attributes:{},classList:{add(x){classes.add(x)},remove(x){classes.delete(x)},toggle(x,on){on?classes.add(x):classes.delete(x)},contains(x){return classes.has(x)}},append(...children){this.children.push(...children)},replaceChildren(...children){this.children=children;this.replacements=(this.replacements||0)+1},addEventListener(type,fn){listeners.set(type,fn)},emit(type,event={}){return listeners.get(type)?.({target:this,...event})},setAttribute(key,value){this.attributes[key]=String(value)},removeAttribute(key){delete this.attributes[key];delete this[key]},setCustomValidity(message){this.validationMessage=message},reportValidity(){return !this.validationMessage},querySelector(){return null},focus(){document.activeElement=this},reset(){for(const id of ["name","phone","address","payment","notes"])document.querySelector(`#checkout-${id}`).value=""}}}
  document.createElement=node;document.body=node();document.querySelector=selector=>{if(!elements.has(selector))elements.set(selector,node());return elements.get(selector)};
  const window={location,crypto:webcrypto,open(...args){opened.push(args)},addEventListener(type,fn){events.set(`window:${type}`,fn)}};
  let timerId=0;
  const context=vm.createContext({window,document,fetch,URL,TextEncoder,Uint8Array,AbortController,localStorage:storage(local,failStorage,failWrites),sessionStorage:storage(session,failStorage,failWrites),setTimeout(fn,delay){const id=++timerId;timeouts.set(id,{fn,delay});return id},clearTimeout(id){timeouts.delete(id)},setInterval(fn,delay){intervals.push({fn,delay});return intervals.length}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,"../assets/js/order-recovery.js"),"utf8"),context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,"../assets/js/app.js"),"utf8")+"\nglobalThis.api={state,init,loadMenu,addToCart,updateQuantity,renderCart,submitCheckout,retryPendingCheckout,loadIntent,openCheckout,toggleCart,toggleCheckout,toggleMobileMenu,handleDialogKeyboard,refreshOrderRecovery,resumeOrderConfirmation,renderOrderRecovery,saveCheckoutDraft,restoreCheckoutDraft};",context);
  const ui={...context.api,element:document.querySelector,opened,location,local,session,events,intervals,document,recovery:window.DapoerOrderRecovery,emit(type,event={}){return events.get(`window:${type}`)?.(event)},runTimeout(delay){const timer=[...timeouts].find(([,item])=>item.delay===delay);assert.ok(timer,`A ${delay}ms deadline must be scheduled`);timeouts.delete(timer[0]);timer[1].fn()}};
  ui.fill=(name="Customer")=>{for(const[key,value]of Object.entries({name,phone:"081234567890",address:"Jalan contoh 123",payment:"DANA",notes:""}))ui.element(`#checkout-${key}`).value=value};
  ui.submit=()=>ui.submitCheckout({preventDefault(){}});return ui;
}
const plain=value=>JSON.parse(JSON.stringify(value));

test("fresh bank-transfer checkout posts the selected method and reviewed total",async()=>{
  const sent=[];const ui=customer(async(url,options)=>{if(url==="/api/menu")return reply({products:[product()]});const payload=JSON.parse(options.body);sent.push(payload);return success(payload)});
  await ui.loadMenu();ui.addToCart(ID);ui.addToCart(ID);ui.fill();ui.element("#checkout-payment").value="Transfer Bank";await ui.submit();
  assert.equal(sent.length,1);assert.equal(sent[0].customer.paymentMethod,"Transfer Bank");assert.equal(sent[0].expectedTotal,74000);assert.deepEqual(sent[0].items,[{id:ID,quantity:2}]);
  assert.equal(ui.element("#checkout-success").hidden,false);assert.equal(ui.loadIntent(),null);assert.equal(ui.state.cart.length,0);
});

test("unavailable payment methods block fresh checkout before posting or saving an intent",async()=>{
  let posts=0;const ui=customer(async(url,options)=>{if(url==="/api/menu")return reply({products:[product()]});posts++;return success(JSON.parse(options.body))});
  await ui.loadMenu();ui.addToCart(ID);ui.fill();ui.element("#checkout-payment").value="Unavailable bank";await ui.submit();
  assert.equal(posts,0);assert.equal(ui.loadIntent(),null);assert.equal(ui.state.cart.length,1);assert.match(ui.element("#checkout-payment").validationMessage,/Pilih metode pembayaran/);
});

test("corrupt cart entries are rejected, duplicates merged, and catalog replaces stored price and name",async()=>{
  const local=new Map([["dapoer-pasta-cart",JSON.stringify([null,{id:ID,quantity:1,name:"Fake",price:1},{id:ID,quantity:2,price:999999},{id:"bad!",quantity:1},{id:ID,quantity:-2},{id:ID,quantity:"8"},{id:ID,quantity:Infinity}])]]);
  const ui=customer(async()=>reply({products:[product()]}),{local});await ui.loadMenu();
  assert.deepEqual(plain(ui.state.cart),[{id:ID,name:product().name,price:37000,quantity:3}]);assert.equal(ui.element("#cart-total").textContent,"Rp 111.000");
});

test("15-second refresh retains menu and cart nodes while updating stock and prices",async()=>{
  let current=product();const ui=customer(async()=>reply({products:[current]}));await ui.loadMenu();ui.addToCart(ID);
  const card=ui.element("#menu-grid").children[0],row=ui.element("#cart-items").children[0];current=product(10,42000);await ui.loadMenu();
  assert.equal(ui.element("#menu-grid").children[0],card);assert.equal(ui.element("#cart-items").children[0],row);assert.equal(ui.element("#cart-total").textContent,"Rp 42.000");assert.equal(ui.state.cart[0].price,42000);
});

test("lost response retries identical body and UUID even after stock and price change, without popup or redirect",async()=>{
  const sent=[];let catalog=product();const ui=customer(async(url,options)=>{if(url==="/api/menu")return reply({products:[catalog]});const payload=JSON.parse(options.body);sent.push(payload);if(sent.length===1)throw new Error("lost response");return success(payload)});
  await ui.loadMenu();ui.addToCart(ID);ui.fill();await ui.submit();assert.equal(ui.element("#checkout-retry").hidden,false);
  catalog=product(0,42000);await ui.loadMenu();await ui.submit();assert.equal(sent.length,2);assert.deepEqual(sent[1],sent[0]);assert.equal(sent[0].expectedTotal,37000);assert.match(sent[0].requestId,/^[a-f0-9-]{36}$/);
  assert.equal(ui.element("#checkout-success").hidden,false);assert.equal(ui.element("#checkout-whatsapp-link").href,"https://api.whatsapp.com/send?phone=6285175391181&text=Konfirmasi");assert.match(ui.element("#checkout-tracking-link").href,/^\/track\//);assert.equal(ui.element("#checkout-receipt-link").href,undefined);assert.equal(ui.state.success.receiptUrl,undefined);assert.equal(ui.opened.length,0);assert.equal(ui.location.href,undefined);assert.equal(ui.loadIntent(),null);
  assert.equal(ui.state.cart.length,0,"automatic catalog repricing must not leave already-ordered cart items behind");
  assert.ok(!JSON.stringify([...ui.local.values()]).includes("Jalan contoh"));
});

test("reload can recover an uncertain checkout from session storage",async()=>{
  const local=new Map(),session=new Map(),sent=[];const first=customer(async(url,options)=>{if(url==="/api/menu")return reply({products:[product()]});sent.push(JSON.parse(options.body));throw new Error("lost")},{local,session});
  await first.loadMenu();first.addToCart(ID);first.fill();await first.submit();
  const second=customer(async(url,options)=>{if(url==="/api/menu")return reply({products:[product(0)]});sent.push(JSON.parse(options.body));return success(sent.at(-1))},{local,session});await second.loadMenu();await second.retryPendingCheckout();
  assert.deepEqual(sent[1],sent[0]);assert.equal(second.state.cart.length,0);assert.equal(second.element("#checkout-success").hidden,false);
  assert.match(second.element("#checkout-tracking-link").href,/^\/track\//);
});

test("duplicate submit is locked and pending cart and customer edits survive success",async()=>{
  let resolveOrder,started,posts=0;const waiting=new Promise(resolve=>{resolveOrder=resolve}),orderStarted=new Promise(resolve=>{started=resolve});const ui=customer(async(url,options)=>{if(url==="/api/menu")return reply({products:[product()]});posts++;started();return waiting.then(()=>success(JSON.parse(options.body)))});await ui.loadMenu();ui.addToCart(ID);ui.fill();
  const saving=ui.submit();await orderStarted;await ui.submit();assert.equal(posts,1);ui.updateQuantity(ID,1);ui.element("#checkout-name").value="New Customer";resolveOrder();await saving;
  assert.equal(ui.state.cart[0].quantity,2);assert.equal(ui.element("#checkout-name").value,"New Customer");assert.match(ui.element("#checkout-notice").textContent,/Perubahan terbaru/);
});

test("catalog repricing while the persisted order response is pending clears only the original ordered items",async()=>{
  let catalog=product(),resolveOrder,started,savedPayload;
  const waiting=new Promise(resolve=>{resolveOrder=resolve}),orderStarted=new Promise(resolve=>{started=resolve});
  const ui=customer(async(url,options)=>{
    if(url==="/api/menu")return reply({products:[catalog]});
    savedPayload=JSON.parse(options.body);started();await waiting;return success(savedPayload);
  });
  await ui.loadMenu();ui.addToCart(ID);ui.fill();
  const saving=ui.submit();await orderStarted;
  catalog=product(0,42000);await ui.loadMenu();
  assert.equal(ui.state.cart[0].price,42000);assert.equal(savedPayload.expectedTotal,37000);
  resolveOrder();await saving;
  assert.equal(ui.state.cart.length,0);assert.equal(ui.element("#checkout-success").hidden,false);
  assert.match(ui.element("#checkout-success-order").textContent,/Rp 37\.000/);
  assert.equal(ui.loadIntent(),null);assert.equal(ui.element("#checkout-notice").hidden,true);
});

test("uncertain old intent is recovered first and does not consume newly edited cart or form",async()=>{
  const sent=[];const ui=customer(async(url,options)=>{if(url==="/api/menu")return reply({products:[product()]});const payload=JSON.parse(options.body);sent.push(payload);if(sent.length===1)throw new Error("lost");return success(payload)});await ui.loadMenu();ui.addToCart(ID);ui.fill();await ui.submit();ui.updateQuantity(ID,1);ui.fill("Different Customer");await ui.submit();assert.equal(sent.length,1);await ui.retryPendingCheckout();assert.deepEqual(sent[1],sent[0]);assert.equal(ui.state.cart[0].quantity,2);assert.equal(ui.element("#checkout-name").value,"Different Customer");
});

test("price change during checkout refresh requires review before a POST",async()=>{
  let price=37000,posts=0;const ui=customer(async(url,options)=>{if(url==="/api/menu")return reply({products:[product(20,price)]});posts++;return success(JSON.parse(options.body))});await ui.loadMenu();ui.addToCart(ID);ui.fill();price=42000;await ui.submit();assert.equal(posts,0);assert.equal(ui.element("#checkout-total").textContent,"Rp 42.000");assert.match(ui.element("#checkout-notice").textContent,/Harga diperbarui/);await ui.submit();assert.equal(posts,1);
});

test("backend PRICE_CHANGED updates total and creates a new UUID only on confirmed next submission",async()=>{
  let price=37000;const sent=[];const ui=customer(async(url,options)=>{if(url==="/api/menu")return reply({products:[product(20,price)]});const payload=JSON.parse(options.body);sent.push(payload);if(sent.length===1){price=42000;return reply({code:"PRICE_CHANGED",error:"Harga berubah"},409)}return success(payload)});await ui.loadMenu();ui.addToCart(ID);ui.fill();await ui.submit();assert.equal(ui.loadIntent(),null);assert.equal(ui.state.cart[0].price,42000);await ui.submit();assert.notEqual(sent[0].requestId,sent[1].requestId);assert.equal(sent[1].expectedTotal,42000);
});

test("blocked storage keeps cart and intent in memory without losing recovery or checkout success",async()=>{
  let posts=0;const sent=[];const ui=customer(async(url,options)=>{if(url==="/api/menu")return reply({products:[product()]});const payload=JSON.parse(options.body);sent.push(payload);if(++posts===1)throw new Error("lost");return success(payload)},{failStorage:true});await ui.loadMenu();ui.addToCart(ID);ui.fill();await ui.submit();await ui.submit();assert.deepEqual(sent[1],sent[0]);assert.equal(ui.state.cart.length,0);assert.equal(ui.state.success.id,"DP-TEST-001");
});

test("REQUEST_CONFLICT preserves the unknown request and blocks blind creation of another order",async()=>{
  const sent=[];const ui=customer(async(url,options)=>{if(url==="/api/menu")return reply({products:[product()]});sent.push(JSON.parse(options.body));return reply({code:"REQUEST_CONFLICT",error:"Permintaan sudah digunakan"},409)});await ui.loadMenu();ui.addToCart(ID);ui.fill();await ui.submit();const id=ui.loadIntent().requestId;assert.match(ui.element("#checkout-notice").textContent,/hubungi WhatsApp admin/i);ui.fill("Changed Customer");await ui.submit();assert.equal(sent.length,1);assert.equal(ui.loadIntent().requestId,id);assert.equal(ui.state.cart[0].quantity,1);
});

test("recovery rejects malicious URLs, mismatched identifiers, duplicate tokens and permanent PII",()=>{
  const ui=customer(async()=>{}),good=`/track/?id=DP-TEST-001&token=${TOKEN}`;
  for(const url of [`https://evil.example${good}`,good+"&token="+TOKEN,good+"&other=x",good+"#fragment",`/nota/?id=DP-TEST-001&token=${TOKEN}`,`/track/?id=DP-TEST-001&token=short`])assert.equal(ui.recovery.safeOrderUrl(url,"/track/"),null);
  assert.equal(ui.recovery.remember({order:{id:"DP-TEST-002"},trackingUrl:good,whatsappUrl:"https://api.whatsapp.com/send?phone=6285175391181"}),null);
  ui.recovery.remember({order:{id:"DP-TEST-001",total:37000,customer:{name:"PII",address:"Secret"}},trackingUrl:good,whatsappUrl:"https://api.whatsapp.com/send?phone=6285175391181&text=Secret"});
  assert.ok(ui.recovery.getWhatsAppUrl({id:"DP-TEST-001",token:TOKEN}));assert.equal(ui.recovery.getWhatsAppUrl({id:"DP-TEST-002",token:TOKEN}),null);assert.equal(ui.recovery.getWhatsAppUrl({id:"DP-TEST-001",token:"b".repeat(48)}),null);assert.ok(!JSON.stringify([...ui.local.values()]).includes("Secret"));
  for(const url of ["http://api.whatsapp.com/send?phone=6285175391181","https://api.whatsapp.com.evil.test/send?phone=6285175391181","https://api.whatsapp.com/send?phone=123","https://api.whatsapp.com/send?phone=6285175391181&phone=123","https://user@api.whatsapp.com/send?phone=6285175391181"])assert.equal(ui.recovery.safeWhatsApp(url),null);
});

const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve()};

test("cart changes from another tab survive a pending checkout without storage rebroadcast",async()=>{
  let finish,started;const waiting=new Promise(resolve=>{finish=resolve}),savingStarted=new Promise(resolve=>{started=resolve});let cartWrites=0;
  const local=new Map();const write=local.set.bind(local);local.set=(key,value)=>{if(key==='dapoer-pasta-cart')cartWrites++;return write(key,value)};
  const sent=[];const ui=customer(async(url,options)=>{if(url==='/api/menu')return reply({products:[product()]});sent.push(JSON.parse(options.body));started();await waiting;return success(sent[0])},{local});
  await ui.init();ui.addToCart(ID);ui.fill();const saving=ui.submit();await savingStarted;
  const changed=[{id:ID,name:'Another tab metadata',price:1,quantity:2}];local.set('dapoer-pasta-cart',JSON.stringify(changed));const writesBeforeEvent=cartWrites;
  ui.emit('storage',{key:'dapoer-pasta-cart'});
  assert.equal(ui.state.cart[0].quantity,2);assert.equal(ui.state.cart[0].price,37000);assert.equal(cartWrites,writesBeforeEvent,'Receiving a storage event must not write back catalog metadata');
  finish();await saving;
  assert.equal(ui.state.cart[0].quantity,2);assert.equal(JSON.parse(local.get('dapoer-pasta-cart'))[0].quantity,2);assert.equal(cartWrites,writesBeforeEvent);assert.equal(sent.length,1);assert.equal(sent[0].items[0].quantity,1);assert.match(ui.element('#checkout-notice').textContent,/tetap disimpan/);
});

test("checkout checks current stored cart even if a cross-tab storage event has not arrived",async()=>{
  let finish,started;const waiting=new Promise(resolve=>{finish=resolve}),savingStarted=new Promise(resolve=>{started=resolve});
  const ui=customer(async(url,options)=>{if(url==='/api/menu')return reply({products:[product()]});started();await waiting;return success(JSON.parse(options.body))});
  await ui.loadMenu();ui.addToCart(ID);ui.fill();const saving=ui.submit();await savingStarted;
  ui.local.set('dapoer-pasta-cart',JSON.stringify([{...ui.state.cart[0],quantity:3}]));
  finish();await saving;assert.equal(ui.state.cart[0].quantity,3);assert.equal(JSON.parse(ui.local.get('dapoer-pasta-cart'))[0].quantity,3);
});

test("quota failure preserves newer in-memory cart instead of replacing it with readable old storage",async()=>{
  let finish,started;const waiting=new Promise(resolve=>{finish=resolve}),savingStarted=new Promise(resolve=>{started=resolve});
  const local=new Map([['dapoer-pasta-cart',JSON.stringify([{id:ID,name:'Old stored cart',price:37000,quantity:1}])]]);
  const ui=customer(async(url,options)=>{if(url==='/api/menu')return reply({products:[product()]});started();await waiting;return success(JSON.parse(options.body))},{local,failWrites:true});
  await ui.loadMenu();ui.fill();const saving=ui.submit();await savingStarted;ui.updateQuantity(ID,1);assert.equal(ui.state.cart[0].quantity,2);
  finish();await saving;assert.equal(ui.state.cart[0].quantity,2);assert.equal(JSON.parse(local.get('dapoer-pasta-cart'))[0].quantity,1);assert.equal(ui.state.success.id,'DP-TEST-001');assert.match(ui.element('#checkout-notice').textContent,/tetap disimpan/);
});

test("retrying an uncertain checkout preserves a newer cart written by another tab",async()=>{
  const sent=[];const ui=customer(async(url,options)=>{if(url==='/api/menu')return reply({products:[product()]});const payload=JSON.parse(options.body);sent.push(payload);if(sent.length===1)throw new Error('lost response');return success(payload)});
  await ui.loadMenu();ui.addToCart(ID);ui.fill();await ui.submit();ui.local.set('dapoer-pasta-cart',JSON.stringify([{...ui.state.cart[0],quantity:2}]));await ui.retryPendingCheckout();
  assert.deepEqual(sent[0],sent[1]);assert.equal(ui.state.cart[0].quantity,2);assert.equal(ui.loadIntent(),null);
});

test("menu deadline releases a hung request, deduplicates reads, and ignores a late stale response",async()=>{
  let calls=0,release,firstSignal;const stalled=new Promise(resolve=>{release=resolve});
  const ui=customer(async(url,options)=>{calls++;if(calls===1){firstSignal=options.signal;return stalled}return reply({products:[product(7,42000)]})});
  const first=ui.loadMenu(),duplicate=ui.loadMenu();assert.equal(calls,1);ui.runTimeout(15000);
  assert.equal(await first,false);assert.equal(await duplicate,false);assert.equal(firstSignal.aborted,true);assert.equal(ui.state.menuRequest,null);assert.equal(ui.state.menuReady,false);assert.equal(ui.state.menuRetry.disabled,false);
  await ui.loadMenu();assert.equal(calls,2);assert.equal(ui.state.menu[0].stock,7);assert.equal(ui.state.menuRetry,null);
  release(reply({products:[product(2,37000)]}));await flush();assert.equal(ui.state.menu[0].stock,7);assert.equal(ui.state.menu[0].price,42000);
});

test("startup installs recovery and cart listeners before the initial menu request settles",async()=>{
  let calls=0;const ui=customer(async()=>{calls++;if(calls===1)return new Promise(()=>{});return reply({products:[product()]})});
  const startup=ui.init();assert.equal(ui.intervals.length,1);assert.equal(ui.intervals[0].delay,15000);assert.ok(ui.events.has('document:visibilitychange'));assert.ok(ui.events.has('window:online'));assert.ok(ui.events.has('window:storage'));
  ui.local.set('dapoer-pasta-cart',JSON.stringify([{id:ID,name:'New cart',price:37000,quantity:2}]));ui.emit('storage',{key:'dapoer-pasta-cart'});assert.equal(ui.state.cart[0].quantity,2);
  ui.emit('online');assert.equal(calls,1);ui.runTimeout(15000);await startup;ui.emit('online');await ui.state.menuRequest;assert.equal(calls,2);assert.equal(ui.state.menuReady,true);assert.equal(ui.state.cart[0].quantity,2);
});

test("initial menu failure offers one retry control and successful retry restores catalog",async()=>{
  let calls=0;const ui=customer(async()=>++calls===1?reply({},503):reply({products:[product()]}));await ui.loadMenu();const retry=ui.state.menuRetry;assert.equal(retry.textContent,'Coba muat menu lagi');
  await retry.emit('click');assert.equal(calls,2);assert.equal(ui.state.menuReady,true);assert.equal(ui.state.menuRetry,null);assert.equal(ui.element('#menu-grid').children.length,1);
});

for(const action of ['Escape','close cart','open another dialog'])test(`delayed checkout cannot reopen after ${action}`,async()=>{
  let calls=0,release;const waiting=new Promise(resolve=>{release=resolve});
  const ui=customer(async()=>{calls++;return calls===2?waiting:reply({products:[product()]})});await ui.loadMenu();ui.addToCart(ID);ui.toggleCart(true);const opening=ui.openCheckout();
  assert.equal(ui.element('#checkout-button').textContent,'Memeriksa stok…');assert.equal(ui.element('#checkout-button').disabled,true);
  const duplicate=ui.openCheckout();await duplicate;assert.equal(calls,2);
  if(action==='Escape')ui.handleDialogKeyboard({key:'Escape',preventDefault(){}});else if(action==='close cart')ui.toggleCart(false);else ui.toggleMobileMenu(true);
  release(reply({products:[product()]}));await opening;assert.equal(ui.state.modal,action==='open another dialog'?'mobile-menu':null);assert.equal(ui.element('#checkout-modal').classList.contains('open'),false);assert.equal(ui.state.checkoutOpening,false);
});

test("menu timeout unlocks checkout navigation and a later attempt opens normally",async()=>{
  let calls=0;const ui=customer(async()=>{calls++;return calls===2?new Promise(()=>{}):reply({products:[product()]})});await ui.loadMenu();ui.addToCart(ID);ui.toggleCart(true);
  const opening=ui.openCheckout();ui.runTimeout(15000);await opening;assert.equal(ui.state.checkoutOpening,false);assert.equal(ui.state.modal,'cart-overlay');assert.equal(ui.state.menuReady,false);
  await ui.loadMenu();await ui.openCheckout();assert.equal(ui.state.modal,'checkout-modal');assert.equal(ui.element('#checkout-button').textContent,'Lanjutkan Checkout');
});

test("pending checkout recovery opens immediately without requiring menu connectivity",async()=>{
  let menuCalls=0;const ui=customer(async(url)=>{if(url==='/api/menu'){menuCalls++;return reply({products:[product()]})}throw new Error('lost')});await ui.loadMenu();ui.addToCart(ID);ui.fill();await ui.submit();const before=menuCalls;
  await ui.openCheckout();assert.equal(menuCalls,before);assert.equal(ui.state.modal,'checkout-modal');assert.equal(ui.element('#checkout-retry').hidden,false);
});

for(const[field,value,message]of [['name','  a  ',/nama lengkap/],['phone','abc123',/WhatsApp/],['address','  ab  ',/alamat/],['payment','Other',/pembayaran/]])test(`invalid ${field} focuses that field and prevents a new checkout request`,async()=>{
  let posts=0;const ui=customer(async(url,options)=>{if(url==='/api/menu')return reply({products:[product()]});posts++;return success(JSON.parse(options.body))});await ui.loadMenu();ui.addToCart(ID);ui.fill();ui.element(`#checkout-${field}`).value=value;await ui.submit();
  assert.equal(posts,0);assert.equal(ui.document.activeElement,ui.element(`#checkout-${field}`));assert.match(ui.element('#checkout-notice').textContent,message);assert.equal(ui.loadIntent(),null);
});

const CURRENT_KEY="dapoer-current-order-v2",DRAFT_KEY="dapoer-checkout-draft-v1",WA_KEY="dapoer-order-whatsapp-v1";
const currentRecord=(extra={})=>({id:"DP-TEST-001",token:TOKEN,trackingUrl:`/track/?id=DP-TEST-001&token=${TOKEN}`,total:37000,queueNumber:7,queueDate:"2026-10-15",savedAt:Date.now(),...extra});
const trackedOrder=(extra={})=>({id:"DP-TEST-001",status:"baru",total:37000,queueNumber:7,queueDate:"2026-10-15",paymentMethod:"Transfer Bank",createdAt:"2026-10-15T01:00:00Z",updatedAt:"2026-10-15T01:00:00Z",items:[{id:ID,name:"Chicken pop corn 250gr",quantity:1,subtotal:37000}],...extra});
const savedLocal=()=>new Map([[CURRENT_KEY,JSON.stringify(currentRecord())]]);

test("closing a saved checkout leaves one reminder and resuming confirms the original order without posting again",async()=>{
  let posts=0,reads=0;
  const ui=customer(async(url,options)=>{
    if(url==="/api/menu")return reply({products:[product()]});
    if(url.startsWith("/api/track?")){reads++;return reply({order:trackedOrder()})}
    posts++;return success(JSON.parse(options.body));
  });
  await ui.loadMenu();ui.addToCart(ID);ui.fill();await ui.submit();
  assert.equal(ui.element("#order-confirmation").hidden,true,"the saved-order modal hides the reminder");
  ui.toggleCheckout(false);assert.equal(ui.element("#order-confirmation").hidden,false);
  assert.match(ui.element("#order-confirmation-summary").textContent,/Antrean A007/);
  await ui.resumeOrderConfirmation();
  assert.equal(posts,1);assert.equal(reads,1);assert.equal(ui.state.modal,"checkout-modal");assert.equal(ui.element("#order-confirmation").hidden,true);
  assert.equal(ui.element("#checkout-whatsapp-link").href,"https://api.whatsapp.com/send?phone=6285175391181&text=Konfirmasi");
  assert.equal(ui.element("#checkout-name").value,"");assert.equal(ui.loadIntent(),null);
});

test("reload restores the saved-order reminder and full session WhatsApp link without opening a dialog or creating another order",async()=>{
  const local=savedLocal(),session=new Map([[WA_KEY,JSON.stringify({id:"DP-TEST-001",token:TOKEN,url:"https://api.whatsapp.com/send?phone=6285175391181&text=PRIVATE_FORM",savedAt:Date.now()})]]);
  let posts=0,reads=0;
  const ui=customer(async(url)=>{if(url==="/api/menu")return reply({products:[product()]});if(url.startsWith("/api/track?")){reads++;return reply({order:trackedOrder()})}posts++;throw new Error("Unexpected POST")},{local,session});
  await ui.init();await ui.refreshOrderRecovery();
  assert.equal(ui.state.modal,null);assert.equal(ui.document.activeElement,null);assert.equal(ui.element("#order-confirmation").hidden,false);
  await ui.resumeOrderConfirmation();assert.equal(posts,0);assert.ok(reads>=1);assert.equal(ui.state.modal,"checkout-modal");
  assert.match(ui.element("#checkout-whatsapp-link").href,/PRIVATE_FORM/);
  assert.ok(!JSON.stringify([...local.values()]).includes("PRIVATE_FORM"));assert.ok(!JSON.stringify([...local.values()]).includes("receiptUrl"));
});

test("a new browser session rebuilds WhatsApp confirmation from verified order data without requiring the old form or leaking customer fields",async()=>{
  const local=savedLocal(),session=new Map();let posts=0;
  const ui=customer(async(url)=>{if(url==="/api/menu")return reply({products:[product()]});if(url.startsWith("/api/track?"))return reply({order:trackedOrder({customer:{name:"PRIVATE_NAME",address:"PRIVATE_ADDRESS"},notes:"PRIVATE_NOTES"})});posts++;throw new Error("Unexpected order")},{local,session});
  await ui.init();await ui.resumeOrderConfirmation();
  const text=new URL(ui.element("#checkout-whatsapp-link").href).searchParams.get("text");
  assert.match(text,/DP-TEST-001/);assert.match(text,/A007/);assert.match(text,/Chicken pop corn 250gr × 1/);assert.match(text,/Rp 37\.000/);assert.match(text,/Transfer Bank/);assert.match(text,/Data pemesan dan alamat sudah diisi/);
  assert.doesNotMatch(text,/PRIVATE_/);assert.equal(posts,0);assert.equal(ui.element("#checkout-name").value,"");
});

test("the current confirmation expires after 24 hours without changing the cart or a newer form draft",async()=>{
  const local=new Map([[CURRENT_KEY,JSON.stringify(currentRecord({savedAt:Date.now()-86400001}))],["dapoer-pasta-cart",JSON.stringify([{id:ID,quantity:1,name:"Pasta",price:37000}])]]);
  const session=new Map([[DRAFT_KEY,JSON.stringify({savedAt:Date.now(),customer:{name:"New draft",phone:"081234567890",address:"Jalan draft baru",paymentMethod:"DANA",notes:""}})]]);
  let reads=0;const ui=customer(async(url)=>{if(url==="/api/menu")return reply({products:[product()]});reads++;throw new Error("Expired recovery must not fetch")},{local,session});
  await ui.init();assert.equal(reads,0);assert.equal(ui.recovery.getCurrent(),null);assert.equal(ui.element("#order-confirmation").hidden,true);
  assert.equal(ui.state.cart.length,1);assert.equal(ui.element("#checkout-name").value,"New draft");assert.ok(session.has(DRAFT_KEY));
});

for(const status of ["dibatalkan","selesai"])test(`verified ${status} removes the reminder and WhatsApp recovery while preserving the next order draft`,async()=>{
  const local=savedLocal(),session=new Map([[WA_KEY,JSON.stringify({id:"DP-TEST-001",token:TOKEN,url:"https://api.whatsapp.com/send?phone=6285175391181&text=OLD",savedAt:Date.now()})],[DRAFT_KEY,"PRESERVE_DRAFT"]]);
  let posts=0;const ui=customer(async(url)=>{if(url.startsWith("/api/track?"))return reply({order:trackedOrder({status})});posts++;throw new Error("Unexpected order")},{local,session});
  await ui.resumeOrderConfirmation();assert.equal(posts,0);assert.equal(ui.state.modal,null);assert.equal(ui.element("#order-confirmation").hidden,true);assert.equal(ui.recovery.getCurrent(),null);assert.equal(session.has(WA_KEY),false);assert.equal(session.get(DRAFT_KEY),"PRESERVE_DRAFT");
});

test("revoked or missing saved-order tracking removes recovery without creating another order",async()=>{
  const local=savedLocal();let reads=0;
  const ui=customer(async(url)=>{assert.match(url,/^\/api\/track\?/);reads++;return reply({error:"Pesanan tidak ditemukan"},404)},{local});
  await ui.resumeOrderConfirmation();assert.equal(reads,1);assert.equal(ui.state.modal,null);assert.equal(ui.recovery.getCurrent(),null);assert.equal(ui.element("#order-confirmation").hidden,true);
});

test("a temporary tracking outage keeps a visible retry reminder and only exposes WhatsApp after a successful fresh read",async()=>{
  const local=savedLocal();let available=false,reads=0;
  const ui=customer(async()=>{reads++;return available?reply({order:trackedOrder()}):reply({error:"Unavailable"},503)},{local});
  await ui.resumeOrderConfirmation();assert.equal(ui.state.modal,null);assert.equal(ui.element("#order-confirmation").hidden,false);assert.equal(ui.element("#order-confirmation-message").hidden,false);assert.match(ui.element("#order-confirmation-message").textContent,/Sambungkan internet/);
  assert.equal(ui.element("#checkout-whatsapp-link").href,undefined);assert.equal(ui.element("#order-confirmation-open").disabled,false);
  available=true;await ui.resumeOrderConfirmation();assert.equal(reads,2);assert.equal(ui.state.modal,"checkout-modal");assert.ok(ui.element("#checkout-whatsapp-link").href);
});

test("tracking timeout releases a deduplicated recovery request and ignores its late terminal response",async()=>{
  const local=savedLocal();let release,reads=0;const stalled=new Promise(resolve=>{release=resolve});
  const ui=customer(async()=>++reads===1?stalled:reply({order:trackedOrder()}),{local});
  const first=ui.refreshOrderRecovery(),duplicate=ui.refreshOrderRecovery();assert.equal(reads,1);ui.runTimeout(12000);assert.equal(await first,null);assert.equal(await duplicate,null);assert.equal(ui.element("#order-confirmation-open").disabled,false);
  await ui.resumeOrderConfirmation();assert.equal(reads,2);assert.equal(ui.state.modal,"checkout-modal");
  release(reply({order:trackedOrder({status:"dibatalkan"})}));await flush();assert.equal(ui.recovery.getCurrent().id,"DP-TEST-001");assert.equal(ui.state.recovery.status,"ready");
});

for(const changed of ["another dialog","chat","another current order"])test(`a delayed recovery cannot open over ${changed}`,async()=>{
  const local=savedLocal();let release;const stalled=new Promise(resolve=>{release=resolve});
  const ui=customer(async()=>stalled,{local});const opening=ui.resumeOrderConfirmation();
  if(changed==="another dialog")ui.toggleCart(true);
  else if(changed==="chat")ui.element("#chat-box").classList.add("open");
  else local.set(CURRENT_KEY,JSON.stringify(currentRecord({id:"DP-TEST-002",trackingUrl:`/track/?id=DP-TEST-002&token=${TOKEN}`})));
  release(reply({order:trackedOrder()}));await opening;
  assert.notEqual(ui.state.modal,"checkout-modal");assert.equal(ui.element("#checkout-whatsapp-link").href,undefined);
  if(changed==="another current order")assert.equal(ui.recovery.getCurrent().id,"DP-TEST-002");
});

test("malformed or mismatched tracking data cannot expose confirmation from forged local metadata",async()=>{
  for(const order of [trackedOrder({id:"DP-OTHER-001"}),trackedOrder({items:[]}),trackedOrder({items:[{name:"Pasta",quantity:-1,subtotal:37000}]}),trackedOrder({updatedAt:"invalid"})]){
    const ui=customer(async()=>reply({order}),{local:savedLocal()});await ui.resumeOrderConfirmation();assert.equal(ui.state.modal,null);assert.equal(ui.state.recovery.status,"offline");assert.equal(ui.element("#checkout-whatsapp-link").href,undefined);
  }
});

test("an unsaved checkout draft survives close and reload in the same tab without becoming permanent local customer data",async()=>{
  const local=new Map(),session=new Map();const ui=customer(async()=>reply({products:[product()]}),{local,session});await ui.init();ui.fill("Draft Customer");ui.element("#checkout-payment").value="Transfer Bank";ui.element("#checkout-notes").value="Kirim sore";ui.toggleCheckout(true);ui.toggleCheckout(false);
  const next=customer(async()=>reply({products:[product()]}),{local,session});await next.init();assert.equal(next.element("#checkout-name").value,"Draft Customer");assert.equal(next.element("#checkout-address").value,"Jalan contoh 123");assert.equal(next.element("#checkout-payment").value,"Transfer Bank");assert.equal(next.element("#checkout-notes").value,"Kirim sore");assert.equal(next.state.modal,null);
  assert.doesNotMatch(JSON.stringify([...local.values()]),/Draft Customer|Jalan contoh|Kirim sore/);
});

test("draft restore fills only blank fields and ignores expired or malformed drafts",async()=>{
  const draft={savedAt:Date.now(),customer:{name:"Stored customer",phone:"081234567890",address:"Stored address",paymentMethod:"Transfer Bank",notes:"Stored notes"}};
  const ui=customer(async()=>{}, {session:new Map([[DRAFT_KEY,JSON.stringify(draft)]])});ui.element("#checkout-name").value="Browser autofill";ui.restoreCheckoutDraft();assert.equal(ui.element("#checkout-name").value,"Browser autofill");assert.equal(ui.element("#checkout-address").value,"Stored address");
  for(const invalid of [{...draft,savedAt:Date.now()-86400001},{...draft,savedAt:Date.now()+120000},{...draft,customer:{...draft.customer,address:[]}}]){
    const invalidUi=customer(async()=>{}, {session:new Map([[DRAFT_KEY,JSON.stringify(invalid)]])});invalidUi.restoreCheckoutDraft();assert.equal(invalidUi.element("#checkout-name").value,"");assert.equal(invalidUi.session.has(DRAFT_KEY),false);
  }
});

test("saved checkout clears only the submitted unchanged draft and preserves customer edits made while saving",async()=>{
  const cleared=customer(async(url,options)=>url==="/api/menu"?reply({products:[product()]}):success(JSON.parse(options.body)));await cleared.loadMenu();cleared.addToCart(ID);cleared.fill();cleared.saveCheckoutDraft();await cleared.submit();assert.equal(cleared.session.has(DRAFT_KEY),false);
  let release,started;const stalled=new Promise(resolve=>{release=resolve}),began=new Promise(resolve=>{started=resolve});
  const ui=customer(async(url,options)=>{if(url==="/api/menu")return reply({products:[product()]});started();await stalled;return success(JSON.parse(options.body))});await ui.loadMenu();ui.addToCart(ID);ui.fill();const saving=ui.submit();await began;ui.fill("Next customer");release();await saving;
  assert.equal(JSON.parse(ui.session.get(DRAFT_KEY)).customer.name,"Next customer");assert.equal(ui.element("#checkout-name").value,"Next customer");
});

test("legacy WhatsApp session links acquire one bounded lifetime without reviving already expired metadata",()=>{
  const session=new Map([[WA_KEY,JSON.stringify({id:"DP-TEST-001",token:TOKEN,url:"https://api.whatsapp.com/send?phone=6285175391181&text=LEGACY_FORM"})]]);
  const ui=customer(async()=>{}, {session});assert.match(ui.recovery.getWhatsAppUrl({id:"DP-TEST-001",token:TOKEN}),/LEGACY_FORM/);const stamp=JSON.parse(session.get(WA_KEY)).savedAt;assert.ok(Number.isFinite(stamp));ui.recovery.getWhatsAppUrl({id:"DP-TEST-001",token:TOKEN});assert.equal(JSON.parse(session.get(WA_KEY)).savedAt,stamp);
  const expired=customer(async()=>{}, {session:new Map([[WA_KEY,JSON.stringify({id:"DP-TEST-001",token:TOKEN,url:"https://api.whatsapp.com/send?phone=6285175391181&text=OLD",savedAt:Date.now()-86400001})]])});assert.equal(expired.recovery.getWhatsAppUrl({id:"DP-TEST-001",token:TOKEN}),null);assert.equal(expired.session.has(WA_KEY),false);
});

test("blocked writes retain the newly saved current order in memory instead of an older readable stored order",()=>{
  const local=new Map([[CURRENT_KEY,JSON.stringify(currentRecord({id:"DP-OLD-001",trackingUrl:`/track/?id=DP-OLD-001&token=${TOKEN}`}))]]);
  const ui=customer(async()=>{}, {local,failWrites:true});const record=ui.recovery.remember({order:{id:"DP-TEST-001",total:37000},trackingUrl:`/track/?id=DP-TEST-001&token=${TOKEN}`,whatsappUrl:"https://api.whatsapp.com/send?phone=6285175391181&text=NEW"});assert.equal(record.id,"DP-TEST-001");assert.equal(ui.recovery.getCurrent().id,"DP-TEST-001");
});

for(const state of ["dibatalkan","selesai","revoked","expired","outage"])test(`returning to an open success modal after ${state} cannot keep a stale WhatsApp action`,async()=>{
  let status="baru";
  const ui=customer(async(url,options)=>{
    if(url==="/api/menu")return reply({products:[product()]});
    if(url.startsWith("/api/track?")){if(status==="revoked")return reply({error:"not found"},404);if(status==="outage")return reply({error:"unavailable"},503);return reply({order:trackedOrder({status})})}
    return success(JSON.parse(options.body));
  });
  await ui.init();ui.addToCart(ID);ui.fill();await ui.submit();assert.equal(ui.element("#checkout-whatsapp-link").hidden,false);
  if(state==="expired"){const record=JSON.parse(ui.local.get(CURRENT_KEY));record.savedAt=Date.now()-86400001;ui.local.set(CURRENT_KEY,JSON.stringify(record))}else status=state;
  ui.events.get("document:visibilitychange")();await ui.state.recoveryRequest?.promise;
  assert.equal(ui.state.modal,"checkout-modal");assert.equal(ui.element("#checkout-whatsapp-link").hidden,true);assert.equal(ui.element("#checkout-whatsapp-link").href,undefined);assert.match(ui.element("#checkout-tracking-link").href,/^\/track\//);assert.equal(ui.element("#checkout-notice").hidden,false);
});

const legacySession=(extra={})=>new Map([[WA_KEY,JSON.stringify({id:"DP-TEST-001",token:TOKEN,url:"https://api.whatsapp.com/send?phone=6285175391181&text=PRIVATE_ORIGINAL_FORM",...extra})]]);

test("a pre-upgrade WhatsApp session becomes a current confirmation only after a verified GET, retaining its original timestamp and full session form",async()=>{
  const local=new Map(),session=legacySession();let release,reads=0;const stalled=new Promise(resolve=>{release=resolve});
  const ui=customer(async(url,options)=>{assert.match(url,/^\/api\/track\?/);assert.ok(!options.method||options.method==="GET");reads++;return stalled},{local,session});
  const first=ui.refreshOrderRecovery(),duplicate=ui.refreshOrderRecovery();
  assert.equal(reads,1);assert.equal(local.has(CURRENT_KEY),false);assert.equal(ui.element("#order-confirmation").hidden,true);assert.equal(ui.state.modal,null);
  const originalStamp=JSON.parse(session.get(WA_KEY)).savedAt;assert.ok(Number.isFinite(originalStamp));
  release(reply({order:trackedOrder({total:30000,items:[{name:"Pasta brulee oval 2 pcs",quantity:1,subtotal:30000}]})}));await first;await duplicate;
  const current=JSON.parse(local.get(CURRENT_KEY));assert.equal(current.total,30000);assert.equal(current.savedAt,originalStamp);assert.equal(current.queueNumber,7);assert.equal(ui.element("#order-confirmation").hidden,false);assert.equal(ui.state.modal,null);assert.doesNotMatch(JSON.stringify([...local.values()]),/PRIVATE_ORIGINAL_FORM/);
  assert.match(ui.recovery.getWhatsAppUrl(current),/PRIVATE_ORIGINAL_FORM/);assert.notEqual(JSON.parse(session.get(WA_KEY)).legacyRecoveryPending,true);
  const reloaded=customer(async()=>reply({order:trackedOrder()}),{local,session});await reloaded.resumeOrderConfirmation();assert.equal(reloaded.state.modal,"checkout-modal");assert.equal(JSON.parse(local.get(CURRENT_KEY)).savedAt,originalStamp);assert.match(reloaded.element("#checkout-whatsapp-link").href,/PRIVATE_ORIGINAL_FORM/);
});

for(const condition of ["cancelled","completed","revoked","mismatched","malformed"])test(`a ${condition} pre-upgrade session cannot become a saved confirmation`,async()=>{
  const local=new Map(),session=legacySession();let reads=0;
  const ui=customer(async(url,options)=>{assert.match(url,/^\/api\/track\?/);assert.ok(!options.method||options.method==="GET");reads++;if(condition==="revoked")return reply({error:"not found"},404);return reply({order:trackedOrder(condition==="cancelled"?{status:"dibatalkan"}:condition==="completed"?{status:"selesai"}:condition==="mismatched"?{id:"DP-OTHER-001"}:{items:[]})})},{local,session});
  await ui.resumeOrderConfirmation();assert.equal(reads,1);assert.equal(local.has(CURRENT_KEY),false);assert.equal(ui.element("#order-confirmation").hidden,true);assert.equal(ui.state.modal,null);assert.equal(ui.element("#checkout-whatsapp-link").href,undefined);
});

test("legacy migration never renews an expired entry or adopts an already timestamped ordinary session",async()=>{
  for(const extra of [{savedAt:Date.now()-86400001},{savedAt:Date.now()},{savedAt:Date.now()-86400001,legacyRecoveryPending:true}]){
    const local=new Map(),session=legacySession(extra);let reads=0;const ui=customer(async()=>{reads++;throw new Error("No migration read allowed")},{local,session});await ui.resumeOrderConfirmation();assert.equal(reads,0);assert.equal(local.has(CURRENT_KEY),false);assert.equal(ui.state.modal,null);assert.equal(ui.element("#order-confirmation").hidden,true);
  }
});

test("an expired current confirmation prevents its plain legacy session from reviving even after a second reload",async()=>{
  const local=new Map([[CURRENT_KEY,JSON.stringify(currentRecord({savedAt:Date.now()-86400001}))]]),session=legacySession();let reads=0;
  for(let attempt=0;attempt<3;attempt++){
    const ui=customer(async()=>{reads++;throw new Error("Expired current must not revive")},{local,session});await ui.resumeOrderConfirmation();assert.equal(local.has(CURRENT_KEY),false);assert.equal(ui.state.modal,null);assert.equal(ui.element("#order-confirmation").hidden,true);
  }
  assert.equal(reads,0);assert.equal(JSON.parse(session.get(WA_KEY)).legacyRecoveryPending,false);
});

test("a delayed legacy migration cannot overwrite a newer order that appears in another tab",async()=>{
  const local=new Map(),session=legacySession();let release;const stalled=new Promise(resolve=>{release=resolve});
  const ui=customer(async()=>stalled,{local,session});const reading=ui.resumeOrderConfirmation();
  const newer=currentRecord({id:"DP-NEW-001",trackingUrl:`/track/?id=DP-NEW-001&token=${TOKEN}`,total:60000});local.set(CURRENT_KEY,JSON.stringify(newer));
  release(reply({order:trackedOrder()}));await reading;assert.equal(JSON.parse(local.get(CURRENT_KEY)).id,"DP-NEW-001");assert.equal(JSON.parse(local.get(CURRENT_KEY)).total,60000);assert.equal(ui.state.modal,null);assert.equal(ui.element("#checkout-whatsapp-link").href,undefined);
});

test("a timed-out legacy migration retries within its first timestamp and ignores a late terminal response",async()=>{
  const local=new Map(),session=legacySession();let release,reads=0;const stalled=new Promise(resolve=>{release=resolve});
  const ui=customer(async()=>++reads===1?stalled:reply({order:trackedOrder()}),{local,session});const first=ui.refreshOrderRecovery(),duplicate=ui.refreshOrderRecovery();const stamp=JSON.parse(session.get(WA_KEY)).savedAt;
  ui.runTimeout(12000);await first;await duplicate;assert.equal(reads,1);assert.equal(local.has(CURRENT_KEY),false);
  await ui.resumeOrderConfirmation();assert.equal(reads,2);assert.equal(JSON.parse(local.get(CURRENT_KEY)).savedAt,stamp);assert.equal(ui.state.modal,"checkout-modal");
  release(reply({order:trackedOrder({status:"dibatalkan"})}));await flush();assert.equal(JSON.parse(local.get(CURRENT_KEY)).id,"DP-TEST-001");
});
