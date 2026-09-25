const PRODUCTS=[
{id:"chicken-pop-corn-250gr",name:"Chicken pop corn 250gr",price:37000,image:"/8.png",badge:"Casa",description:"Ayam pilihan dengan tekstur renyah, praktis untuk dinikmati kapan saja."},
{id:"chicken-cordon-blue-7pcs",name:"Chicken Cordon Blue 7 pcs",price:37000,image:"/9.png",badge:"Signature",description:"Ayam dengan smoked beef dan mozzarella, gurih dengan bagian dalam yang creamy."},
{id:"mini-wonton-250gr",name:"Mini wonton 250gr",price:37000,image:"/7 m.png",badge:"Croccante",description:"Mini wonton berisi ayam dan udang dengan sensasi renyah yang menggugah selera."},
{id:"pasta-brulee-oval-2pcs",name:"Pasta brulee oval 2 pcs",price:27000,image:"/10.png",badge:"Brûlée",description:"Pasta creamy dengan ayam dan keju leleh dalam porsi oval yang praktis."},
{id:"pasta-brulee-persegi-2pcs",name:"Pasta brulee persegi 2 pcs",price:32000,image:"/11.png",badge:"Signature",description:"Pasta creamy dengan ayam dan keju leleh dalam porsi persegi yang lebih mantap."}
];
exports.handler=async function(event){
if(event.httpMethod!=="GET")return{statusCode:405,headers:{"Content-Type":"application/json",Allow:"GET"},body:JSON.stringify({error:"Method not allowed"})};
return{statusCode:200,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"public, max-age=300, s-maxage=1800"},body:JSON.stringify({store:{name:"Dapoer Pasta",whatsapp:"6285175391181",instagram:"Dapoer.Pasta",paymentMethods:["OVO","ShopeePay","DANA"]},products:PRODUCTS})};
};