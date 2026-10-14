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
function storage(map,fail=false){return{getItem(key){if(fail)throw new Error("denied");return map.get(key)||null},setItem(key,value){if(fail)throw new Error("denied");map.set(key,String(value))},removeItem(key){if(fail)throw new Error("denied");map.delete(key)}}}
function customer(fetch,{local=new Map(),session=new Map(),failStorage=false}={}){
  const elements=new Map(),opened=[],location={origin:"https://example.com"},document={hidden:false,activeElement:null,addEventListener(){},querySelectorAll(){return[]}};
  function node(){const classes=new Set();return{children:[],value:"",textContent:"",hidden:false,disabled:false,isConnected:true,inert:false,attributes:{},classList:{add(x){classes.add(x)},remove(x){classes.delete(x)},toggle(x,on){on?classes.add(x):classes.delete(x)},contains(x){return classes.has(x)}},append(...children){this.children.push(...children)},replaceChildren(...children){this.children=children;this.replacements=(this.replacements||0)+1},addEventListener(){},setAttribute(key,value){this.attributes[key]=String(value)},querySelector(){return null},focus(){document.activeElement=this},reset(){for(const id of ["name","phone","address","payment","notes"])document.querySelector(`#checkout-${id}`).value=""}}}
  document.createElement=node;document.body=node();document.querySelector=selector=>{if(!elements.has(selector))elements.set(selector,node());return elements.get(selector)};
  const window={location,crypto:webcrypto,open(...args){opened.push(args)},addEventListener(){}};
  const context=vm.createContext({window,document,fetch,URL,TextEncoder,Uint8Array,AbortController,localStorage:storage(local,failStorage),sessionStorage:storage(session,failStorage),setTimeout:()=>1,clearTimeout(){},setInterval:()=>1});
  vm.runInContext(fs.readFileSync(path.join(__dirname,"../assets/js/order-recovery.js"),"utf8"),context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,"../assets/js/app.js"),"utf8")+"\nglobalThis.api={state,loadMenu,addToCart,updateQuantity,renderCart,submitCheckout,retryPendingCheckout,loadIntent};",context);
  const ui={...context.api,element:document.querySelector,opened,location,local,session,recovery:window.DapoerOrderRecovery};
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
