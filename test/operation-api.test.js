const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { createRequestGuard } = require("../api/_lib/security");
const { PRODUCTS } = require("../api/_lib/catalog");
const { orderFingerprint, validateExpectedStatus } = require("../api/_lib/operations");
const inventory = require("../api/_lib/inventory");

const uuid = "6839a62e-37a1-4e77-89ba-ea2f92ce331f";
const observedVersion = "2026-10-14T08:00:00.123456+00:00";
const customer = { name: "Local customer", phone: "081234567890", address: "Test address", notes: "", paymentMethod: "DANA" };
const checkout = () => ({ requestId: uuid, expectedTotal: PRODUCTS[0].price, items: [{ id: PRODUCTS[0].id, quantity: 1 }], customer });
function request(body, method = "POST", headers = {}) {
  return { body, method, socket: { remoteAddress: "127.0.0.1" }, headers: {
    host: "shop.example.test", "content-type": "application/json", ...headers
  } };
}
function response() {
  return { headers: {}, setHeader(name,value) { this.headers[name.toLowerCase()]=value; },
    status(code) { this.statusCode=code; return this; }, json(body) { this.body=body; return this; } };
}
function handler(path, overrides = {}, guard) {
  const target = require.resolve(`../api/${path}`);
  delete require.cache[target];
  const originalLoad = Module._load;
  const fixtureGuard=createRequestGuard({ getSql: () => null, environment: {} });
  Module._load = function(name,parent,isMain) {
    if (parent?.filename === target && name.endsWith("/_lib/security")) return {
      guardRequest: guard || ((req,res,options)=>fixtureGuard(req,res,{...options,limit:1000}))
    };
    if (parent?.filename === target && name.endsWith("/_lib/db")) return overrides;
    if (parent?.filename === target && name.endsWith("/_lib/auth")) return {
      verifySession: () => ({ email: "local@example.test" }), clearSessionCookie: () => "dp_admin_session=; Max-Age=0"
    };
    if (parent?.filename === target && name.endsWith("/_lib/inventory")) return { ...inventory, ...overrides };
    return originalLoad.call(this,name,parent,isMain);
  };
  try { return require(target); } finally { Module._load=originalLoad; }
}

test("malformed checkout retry IDs and displayed totals never reach persistence", async () => {
  let writes=0;
  const api=handler("order",{ saveOrder: async () => { writes++; return true; } });
  for (const requestId of [null,"", "not-a-uuid", 42, uuid.replace("4e77","0e77")]) {
    const res=response(); await api(request({ ...checkout(),requestId }),res);
    assert.equal(res.statusCode,400); assert.equal(res.body.code,"INVALID_REQUEST_ID");
  }
  for (const expectedTotal of [null,0,-1,1.5,"37000",true,Number.MAX_SAFE_INTEGER+1]) {
    const res=response(); await api(request({ ...checkout(),expectedTotal }),res);
    assert.equal(res.statusCode,400); assert.equal(res.body.code,"INVALID_EXPECTED_TOTAL");
  }
  assert.equal(writes,0);
});

test("checkout successful replay uses its saved values in the response and WhatsApp", async () => {
  const api=handler("order",{ saveOrder: async order => {
    assert.equal(order.requestId,uuid); assert.equal(order.expectedTotal,PRODUCTS[0].price);
    Object.assign(order,{ id:"DP-original", total:15000, items:[{ id:PRODUCTS[0].id,name:"Original menu",quantity:1,price:15000,subtotal:15000 }],
      customer:{ ...customer,name:"Original customer" },trackingToken:"a".repeat(48),queueNumber:3,queueDate:"2026-10-14",queueLabel:"A003" });
    return true;
  } });
  const res=response(); await api(request(checkout()),res);
  assert.equal(res.statusCode,200); assert.equal(res.body.order.id,"DP-original");
  assert.equal(res.body.order.total,15000); assert.equal(res.body.order.customer.name,"Original customer");
  const text=new URL(res.body.whatsappUrl).searchParams.get("text");
  assert.match(text,/Original menu/); assert.match(text,/TOTAL PESANAN: Rp 15\.000/);
  assert.match(text,/No\. Antrian: \*A003\*/);
  assert.equal(new URL(res.body.trackingUrl).searchParams.get("token"),"a".repeat(48));
});

test("price and request conflicts expose confirmation details without successful order links", async () => {
  for (const code of ["PRICE_CHANGED","REQUEST_CONFLICT"]) {
    const api=handler("order",{ saveOrder: async () => { throw Object.assign(new Error(code),{ code }); } });
    const res=response(); await api(request(checkout()),res);
    assert.equal(res.statusCode,409); assert.equal(res.body.code,code);
    assert.equal(res.body.trackingUrl,undefined); assert.equal(res.body.whatsappUrl,undefined);
    if (code === "PRICE_CHANGED") { assert.equal(res.body.total,PRODUCTS[0].price); assert.equal(res.body.items[0].price,PRODUCTS[0].price); }
  }
});

test("fingerprints preserve item order equivalence and exclude mutable catalog prices", () => {
  const base={ customer, expectedTotal:74000,items:[{id:"b",quantity:1,price:100},{id:"a",quantity:2,price:200}] };
  assert.equal(orderFingerprint(base),orderFingerprint({ ...base,items:[{id:"a",quantity:2,price:400},{id:"b",quantity:1,price:500}] }));
  assert.notEqual(orderFingerprint(base),orderFingerprint({ ...base,expectedTotal:75000 }));
  assert.notEqual(orderFingerprint(base),orderFingerprint({ ...base,customer:{...customer,notes:"Changed"} }));
});

test("stock APIs carry canonical retry IDs and report conflicts without silently mutating again", async () => {
  const calls=[];
  const api=handler("admin/stock",{ adjustStock:async (...args)=> { calls.push(args); return {...PRODUCTS[0],stock:5}; },
    setStock:async (...args)=>{ calls.push(args); return {...PRODUCTS[0],stock:0}; } });
  for (const body of [{id:PRODUCTS[0].id,delta:2,requestId:uuid.toUpperCase()},
    {id:PRODUCTS[0].id,stock:0,expectedStock:5,requestId:uuid}]) {
    const res=response(); await api(request(body,"PATCH"),res); assert.equal(res.statusCode,200);
  }
  assert.deepEqual(calls,[[PRODUCTS[0].id,2,uuid],[PRODUCTS[0].id,0,5,uuid]]);
  const invalid=response(); await api(request({id:PRODUCTS[0].id,delta:2,requestId:null},"PATCH"),invalid);
  assert.equal(invalid.statusCode,400); assert.equal(calls.length,2);
  const conflict=handler("admin/stock",{ adjustStock: async()=>{throw Object.assign(new Error("REQUEST_CONFLICT"),{code:"REQUEST_CONFLICT"});} });
  const res=response(); await conflict(request({id:PRODUCTS[0].id,delta:2,requestId:uuid},"PATCH"),res);
  assert.equal(res.statusCode,409); assert.equal(res.body.code,"REQUEST_CONFLICT");
});

test("status writes carry the exact microsecond version and reject incomplete or impossible observations", async () => {
  const calls=[];
  const api=handler("admin/status",{updateOrderStatus:async (...args)=>{ calls.push(args); return {id:args[0],status:args[1]}; }});
  const res=response(); await api(request({id:"DP-test",status:"selesai",expectedStatus:"baru",expectedUpdatedAt:observedVersion},"PATCH"),res);
  assert.equal(res.statusCode,200);
  assert.deepEqual(calls,[["DP-test","selesai",{expectedStatus:"baru",expectedUpdatedAt:observedVersion}]]);
  for (const body of [{expectedStatus:"baru"},{expectedUpdatedAt:observedVersion},{expectedStatus:"unknown",expectedUpdatedAt:observedVersion},
    {expectedStatus:"baru",expectedUpdatedAt:"2026-02-30T00:00:00.123456Z"},{expectedStatus:"baru",expectedUpdatedAt:"2026-10-14T24:00:00Z"},
    {expectedStatus:"baru",expectedUpdatedAt:"2026-10-14T00:00:00.123456+23:00"},
    {expectedStatus:"baru",expectedUpdatedAt:"2026-10-14T00:00:00.123456-16:00"}]) {
    const denied=response(); await api(request({id:"DP-test",status:"selesai",...body},"PATCH"),denied);
    assert.equal(denied.statusCode,400); assert.equal(denied.body.code,"INVALID_EXPECTED_STATUS");
  }
  assert.equal(calls.length,1);
  assert.deepEqual(validateExpectedStatus({expectedStatus:"baru",expectedUpdatedAt:observedVersion}),{expectedStatus:"baru",expectedUpdatedAt:observedVersion});
});

test("status conflicts describe stale versions, blocked reversals and fulfilled-order cancellation", async () => {
  for (const code of ["ORDER_CONFLICT","INVALID_STATUS_TRANSITION","CANCELLATION_NOT_ALLOWED","ORDER_CANCELLED"]) {
    const api=handler("admin/status",{updateOrderStatus:async()=>{throw Object.assign(new Error(code),{code});}});
    const res=response(); await api(request({id:"DP-test",status:"dibatalkan",expectedStatus:"baru",expectedUpdatedAt:observedVersion},"PATCH"),res);
    assert.equal(res.statusCode,409); assert.equal(res.body.code,code); assert.equal(res.body.order,undefined);
  }
});

test("logout clears the cookie with a failed database but retains method, origin and JSON protections", async () => {
  let databaseReads=0;
  const guard=createRequestGuard({getSql:()=>{databaseReads++;throw new Error("Database unavailable");},environment:{VERCEL:"1",NODE_ENV:"production"}});
  const api=handler("admin/logout",{},guard);
  const accepted=response(); await api(request({},"POST",{origin:"https://shop.example.test","x-real-ip":"203.0.113.10"}),accepted);
  assert.equal(accepted.statusCode,200); assert.match(accepted.headers["set-cookie"],/Max-Age=0/); assert.equal(databaseReads,0);
  for (const [method,headers,status] of [["GET",{},405],["POST",{origin:"https://attacker.example","sec-fetch-site":"cross-site"},403],
    ["POST",{"content-type":"text/plain"},415],["POST",{"content-length":"20000"},413]]) {
    const res=response(); await api(request({},method,headers),res); assert.equal(res.statusCode,status); assert.equal(res.headers["set-cookie"],undefined);
  }
  assert.equal(databaseReads,0);
});
