const { STORE, PRODUCTS } = require("./_lib/catalog");

module.exports = function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  res.setHeader("Cache-Control", "public, max-age=300, s-maxage=1800");
  return res.status(200).json({ store: STORE, products: PRODUCTS });
};
