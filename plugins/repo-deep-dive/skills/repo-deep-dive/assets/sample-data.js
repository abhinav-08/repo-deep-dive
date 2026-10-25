/* Sample data block: a tiny fictional orders platform that exercises every field. Replace all of it per repo.
   `ev` paths are repo-relative ("<repo>/<path>:<line|a-b>"): svcmap_diff.js maps a git diff onto node ids through them. */
const CFG={
  title:"Orders Service Map",                     // h1 (the <title> comes from build_svcmap.py --title)
  kicker:"Example · checkout-api and fulfilment",  // small caps line above the title
  find:"cart, retry, coupon…",                     // search box placeholder
  key:"orders-map",                                // localStorage namespace for the last selection
  open:["root","api","api_val"],                   // nodes open on first load
  sel:"api_cartok"                                 // node selected on first load
  // lede:"...", foot:"..."                         // optional HTML; sensible defaults otherwise
};
const D={
  req:{n:"checkout request",d:"POST /v1/checkout with cartId, coupon and a payment token",s:`{ cartId:"c-91", coupon:"SAVE10", paymentToken:"tok_..." }`},
  cart:{n:"cart",d:"Cart rows with prices, loaded from Postgres",s:`{ id, userId, items:[{ sku, qty, unitPrice }], currency }`},
  total:{n:"order total",d:"Subtotal minus coupon, plus tax"},
  pay:{n:"payment result",d:"Gateway authorization id or a decline code"},
  evt:{n:"OrderPlaced event",d:"Kafka message consumed by fulfilment",s:`topic orders.v1, key = orderId
{ orderId, userId, total, items[] }`}
};
const N={id:"root",k:"system",t:"Orders Platform",s:"example data for the template",
 d:"Click the root toggle to open every level at once.",kids:[
 {id:"web",k:"external",t:"Web and app clients",out:["req"],c:"Doc"},
 {id:"api",k:"service",t:"checkout-api",s:"Spring Boot · 6 pods",
  calls:[["PostgreSQL","cart reads, 200 ms statement timeout"],["payments-gw","authorize, 2 s per try, 3 tries"],["Kafka","publish orders.v1"]],kids:[
  {id:"api_val",k:"stage",t:"Validate",kids:[
   {id:"api_load",k:"step",t:"Load cart",s:"CartRepository.findById",in:["req"],out:["cart"],ev:"checkout-api/src/main/java/com/shop/cart/CartRepository.java:41",c:"Code"},
   {id:"api_cartok",k:"decision",t:"Cart usable?",in:["cart"],
    br:[["cart == null","404 CART_NOT_FOUND"],["cart.items empty","400 EMPTY_CART"],["otherwise","continue to pricing"]],ev:"checkout-api/src/main/java/com/shop/checkout/CheckoutService.java:58-71",c:"Code"}]},
  {id:"api_price",k:"stage",t:"Price and pay",kids:[
   {id:"api_total",k:"step",t:"Compute total",in:["cart"],out:["total"],ev:"checkout-api/src/main/java/com/shop/pricing/PricingService.java:22-40",c:"Code"},
   {id:"api_pay",k:"external",t:"Authorize payment",s:"payments-gw POST /authorize",in:["total"],out:["pay"],
    warn:"Retries a non-idempotent call without an idempotency key.",ev:"checkout-api/src/main/java/com/shop/pay/PaymentClient.java:30-77",c:"Code"},
   {id:"api_pub",k:"step",t:"Publish OrderPlaced",in:["pay","total"],out:["evt"],ev:"checkout-api/src/main/java/com/shop/events/OrderEvents.java:19",c:"Code"}]},
  {id:"pg",k:"store",t:"orders-db (Postgres)",s:"carts, cart_items, orders",out:["cart"],c:"Code"}]},
 {id:"ful",k:"service",t:"fulfilment",s:"Kafka consumer group fulfilment-v2",kids:[
  {id:"ful_consume",k:"step",t:"Consume OrderPlaced",in:["evt"],uses:"Creates one pick list per warehouse.",c:"Doc"}]}
]};
const EXTRA={
 api_load:{what:["Reads the cart and its items in one query.","Prices come from the cart rows, not from the catalogue."],
  ext:{sys:"PostgreSQL",tag:"SQL",cluster:"orders-db primary",target:"carts, cart_items",api:"SELECT with JOIN",when:"every checkout",
   timeout:"200 ms statement timeout, no retry",req:L`SELECT c.id, i.sku, i.qty, i.unit_price
FROM carts c JOIN cart_items i ON i.cart_id = c.id
WHERE c.id = :cartId`,resp:"Rows mapped to Cart; an empty result means the cart is missing.",conf:"Code"}},
 api_cartok:{what:["Rejects missing or empty carts before any pricing work."],
  logic:L`if (cart == null)              throw NotFound("CART_NOT_FOUND")   // 404
else if (cart.items.isEmpty()) throw BadRequest("EMPTY_CART")      // 400
// otherwise fall through to pricing`,
  brx:["The client shows 'cart expired'.","The client returns to the catalogue.","Pricing runs next."]},
 api_total:{what:["Sums qty × unit price, applies the coupon, then adds tax on the discounted amount."],fx:["total"]},
 api_pay:{what:["Calls the gateway; on timeout it waits 200 ms × 2^n and tries again, up to 3 tries."],fx:["retry"],
  ext:[{sys:"HTTP",tag:"HTTP",target:"payments-gw POST /authorize",when:"after pricing",timeout:"2 s per try, 3 tries, backoff 200 ms × 2^n",conf:"Code"}]},
 api_pub:{what:["Publishes once the payment is authorized; key = orderId keeps an order on one partition."],
  ext:{sys:"Kafka",tag:"KAFKA",target:"topic orders.v1",api:"KafkaTemplate.send",when:"payment authorized",notes:"acks=all from the producer config.",conf:"Code"}}
};
const FX={
 total:{t:"Order total",conf:"Code",ev:"checkout-api/src/main/java/com/shop/pricing/PricingService.java:22-40",d:"Subtotal minus coupon (capped), then tax on the discounted amount.",
  inp:[{id:"sub",type:"num",label:"Subtotal",v:120},{id:"cp",type:"select",label:"Coupon",v:"10",opts:[["0","none"],["10","SAVE10 (10%)"],["25","SAVE25 (25%)"]]},
       {id:"tax",type:"range",label:"Tax rate %",min:0,max:20,step:0.5,v:5},{id:"cap",type:"check",label:"Cap discount at 20",v:true}],
  run(v){ let disc=v.sub*(+v.cp)/100; if(v.cap) disc=Math.min(disc,20); const net=v.sub-disc, tax=net*v.tax/100;
   return {rows:[["Discount",fmt(disc)],["Taxable amount",fmt(net)],["Tax",fmt(tax)],["Total",fmt(net+tax),"ok"]],
    svg:plot({f:x=>(x-(v.cap?Math.min(x*(+v.cp)/100,20):x*(+v.cp)/100))*(1+v.tax/100),lo:0,hi:Math.max(200,v.sub*1.5),x:v.sub,xl:"subtotal",aria:"Total against subtotal"}),
    note:"The cap applies before tax."}; }},
 retry:{t:"Payment retry timeline",conf:"Code",ev:"checkout-api/src/main/resources/application-prod.yml:12-18",d:"3 tries, 2 s timeout each, 200 ms × 2^n wait between tries.",
  inp:[{id:"lat",type:"range",label:"Gateway latency (ms)",min:100,max:3000,step:50,v:2500}],
  run(v){ const segs=[]; let t=0, ok=false;
   for(let i=0;i<3&&!ok;i++){ const d=Math.min(v.lat,2000); ok=v.lat<=2000;
    segs.push({a:t,b:t+d,label:"try "+(i+1)+(ok?" ok":" timeout"),cls:ok?"good":"bad"}); t+=d;
    if(!ok&&i<2){ const w=200*2**i; segs.push({a:t,b:t+w,label:"wait "+w+" ms",cls:"wait"}); t+=w; } }
   return {rows:[["Outcome",ok?"authorized":"failed after 3 tries",ok?"ok":"bad"],["Time spent",fmt(t)+" ms"]],
    svg:bars(segs,Math.max(t,1),"ms","Payment retry timeline"),trace:segs.map(s=>s.label+": "+fmt(s.a)+" to "+fmt(s.b)+" ms")}; }}
};
