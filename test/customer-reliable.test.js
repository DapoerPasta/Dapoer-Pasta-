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
  function node(){const classes=new Set(),listeners=new Map();return{children:[],value:"",textContent:"",hidden:false,disabled:false,isConnected:true,inert:false,validationMessage:"",attributes:{},classList:{add(x){classes.add(x)},remove(x){classes.delete(x)},toggle(x,on){on?classes.add(x):classes.delete(x)},contains(x){return classes.has(x)}},append(...children){this.children.push(...children)},replaceChildren(...children){this.children=children;this.replacements=(this.replacements||0)+1},addEventListener(type,fn){listeners.set(type,fn)},emit(type,event={}){return listeners.get(type)?.({target:this,...event})},setAttribute(key,value){this.attributes[key]=String(value)},removeAttribute(key){delete this.attributes[key]},setCustomValidity(message){this.validationMessage=message},reportValidity(){return !this.validationMessage},querySelector(){return null},focus(){document.activeElement=this},reset(){for(const id of ["name","phone","address","payment","notes"])document.querySelector(`#checkout-${id}`).value=""}}}
  document.createElement=node;document.body=node();document.querySelector=selector=>{if(!elements.has(selector))elements.set(selector,node());return elements.get(selector)};
  const window={location,crypto:webcrypto,open(...args){opened.push(args)},addEventListener(type,fn){events.set(`window:${type}`,fn)}};
  let timerId=0;
  const context=vm.createContext({window,document,fetch,URL,TextEncoder,Uint8Array,AbortController,localStorage:storage(local,failStorage,failWrites),sessionStorage:storage(session,failStorage,failWrites),setTimeout(fn,delay){const id=++timerId;timeouts.set(id,{fn,delay});return id},clearTimeout(id){timeouts.delete(id)},setInterval(fn,delay){intervals.push({fn,delay});return intervals.length}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,"../assets/js/order-recovery.js"),"utf8"),context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,"../assets/js/app.js"),"utf8")+"\nglobalThis.api={state,init,loadMenu,addToCart,updateQuantity,renderCart,submitCheckout,retryPendingCheckout,loadIntent,openCheckout,toggleCart,toggleMobileMenu,handleDialogKeyboard};",context);
  const ui={...context.api,element:document.querySelector,opened,location,local,session,events,intervals,document,recovery:window.DapoerOrderRecovery,emit(type,event={}){return events.get(`window:${type}`)?.(event)},runTimeout(delay){const timer=[...timeouts].find(([,item])=>item.delay===delay);assert.ok(timer,`A ${delay}ms deadline must be scheduled`);timeouts.delete(timer[0]);timer[1].fn()}};
  ui.fill=(name="Customer")=>{for(const[key,value]of Object.entries({name,phone:"081234567890",address:"Jalan contoh 123",payment:"DANA",notes:""}))ui.element(`#checkout-${key}`).value=value};
  ui.submit=()=>ui.submitCheckout({preventDefault(){}});return ui;
}
const plain=value=>JSON.parse(JSON.stringify(value));

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
  assert.equal(ui.element("#checkout-success").hidden,false);assert.equal(ui.element("#checkout-whatsapp-link").href,"https://api.whatsapp.com/send?phone=6285175391181&text=Konfirmasi");assert.match(ui.element("#checkout-tracking-link").href,/^\/track\//);assert.match(ui.element("#checkout-receipt-link").href,/^\/nota\//);assert.equal(ui.opened.length,0);assert.equal(ui.location.href,undefined);assert.equal(ui.loadIntent(),null);
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
  ui.recovery.remember({order:{id:"DP-TEST-001",customer:{name:"PII",address:"Secret"}},trackingUrl:good,whatsappUrl:"https://api.whatsapp.com/send?phone=6285175391181&text=Secret"});
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
