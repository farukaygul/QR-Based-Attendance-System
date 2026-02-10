const jwt = require("jsonwebtoken");

/**
 * Admin JWT doğrulama middleware'i.
 * Authorization: Bearer <token> header'ını kontrol eder.
 */
function requireAdminAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      status: "error",
      message: "Yetkilendirme başlığı eksik veya hatalı. Bearer token gereklidir.",
    });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.adminUser = decoded; // { sub: "admin", iat, exp }
    next();
  } catch (err) {
    const message =
      err.name === "TokenExpiredError"
        ? "Oturum süresi dolmuş. Lütfen tekrar giriş yapın."
        : "Geçersiz token. Lütfen tekrar giriş yapın.";

    return res.status(401).json({
      status: "error",
      message,
    });
  }
}

module.exports = { requireAdminAuth };
