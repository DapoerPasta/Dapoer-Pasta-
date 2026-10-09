const { verifySession } = require("../_lib/auth");
const { guardRequest } = require("../_lib/security");
const { FinanceValidationError, parseFinanceQuery, validateExpenseCreate, validateExpenseUpdate, validateExpenseDelete } = require("../_lib/finance");
const { getFinanceReport, createExpense, updateExpense, deleteExpense } = require("../_lib/finance-db");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  // Authenticate before even rate-limit/schema queries: financial information
  // and expense mutation are restricted to the existing signed admin session.
  if (!verifySession(req)) return res.status(401).json({ error: "Unauthorized" });
  if (!(await guardRequest(req, res, { scope: "admin", methods: ["GET", "POST", "PATCH", "DELETE"] }))) return;
  try {
    if (req.method === "GET") return res.status(200).json(await getFinanceReport(parseFinanceQuery(req)));
    if (req.method === "POST") {
      const result = await createExpense(validateExpenseCreate(req.body));
      return res.status(result.created ? 201 : 200).json(result);
    }
    if (req.method === "PATCH") return res.status(200).json(await updateExpense(validateExpenseUpdate(req.body)));
    return res.status(200).json(await deleteExpense(validateExpenseDelete(req.body)));
  } catch (error) {
    if (error instanceof FinanceValidationError || error?.code === "INVALID_FINANCE_INPUT") {
      return res.status(400).json({ code: "INVALID_FINANCE_INPUT", error: error.message });
    }
    if (error?.code === "EXPENSE_CONFLICT") {
      return res.status(409).json({ code: error.code, error: "Catatan pengeluaran sudah berubah atau ID telah digunakan. Muat ulang laporan dan periksa data terbaru sebelum mencoba lagi." });
    }
    if (error?.code === "EXPENSE_NOT_FOUND") {
      return res.status(404).json({ code: error.code, error: "Catatan pengeluaran tidak ditemukan atau sudah dihapus." });
    }
    if (error?.code === "DATABASE_NOT_CONFIGURED" || error?.message === "DATABASE_NOT_CONFIGURED") {
      return res.status(503).json({ error: "Database belum dikonfigurasi." });
    }
    console.error("Finance request failed");
    return res.status(503).json({ error: "Laporan keuangan atau pengeluaran belum dapat diproses. Silakan coba lagi." });
  }
};
