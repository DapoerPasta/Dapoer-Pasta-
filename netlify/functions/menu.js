const { STORE, PRODUCTS } = require("./_lib/catalog");

exports.handler = async function handler(event) {
  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers: { "Content-Type": "application/json", Allow: "GET" },
      body: JSON.stringify({ error: "Method not allowed" })
    };
  }

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=1800"
    },
    body: JSON.stringify({ store: STORE, products: PRODUCTS })
  };
};
