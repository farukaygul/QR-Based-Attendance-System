const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// Configuration
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 dakika varsayılan
const QR_CODE_DIR =
  process.env.QR_CODE_DIR || path.join(__dirname, "public", "qrcodes");

// Track active QR tokens (short-lived scan tokens) and IP cache
const activeSessions = new Map();
const ipCache = new Map();

// Ensure QR code directory exists
if (!fs.existsSync(QR_CODE_DIR)) {
  fs.mkdirSync(QR_CODE_DIR, { recursive: true });
}

/**
 * @param {string} ipAddress
 * @param {number} [ttlMs] — QR token TTL in milliseconds (default 5 min)
 * @param {string} [dbSessionId] — DB Session._id (yoksa eski davranış)
 */
async function generateQRCode(ipAddress, ttlMs, dbSessionId) {
  const ttl = typeof ttlMs === "number" && ttlMs > 0 ? ttlMs : DEFAULT_TTL_MS;

  // Check cache — bypass if TTL changed or dbSessionId changed
  if (ipCache.has(ipAddress)) {
    const cached = ipCache.get(ipAddress);
    const remaining = cached.expiresAt - Date.now();
    if (remaining > 0 && cached.ttlMs === ttl && cached.dbSessionId === (dbSessionId || null)) {
      return { ...cached.data, expiresIn: remaining };
    }
  }

  try {
    const qrToken = crypto.randomBytes(16).toString("hex");
    const timestamp = Date.now();

    const secretKey = process.env.QR_SECRET_KEY || "default-secret-key";
    const hash = crypto
      .createHash("sha256")
      .update(qrToken + timestamp + secretKey)
      .digest("hex");

    const baseUrl =
      process.env.BASE_URL ||
      `http://localhost:${process.env.PORT || 5050}`;

    // QR data: sessionId = DB session, qrToken = short-lived scan token
    const qrPayload = { qrToken, timestamp, hash };
    if (dbSessionId) qrPayload.sessionId = dbSessionId;

    const qrData = `${baseUrl}/verify-attendance?data=${encodeURIComponent(
      JSON.stringify(qrPayload)
    )}`;

    const fileName = `qr_${timestamp}.png`;
    const filePath = path.join(QR_CODE_DIR, fileName);

    await QRCode.toFile(filePath, qrData, {
      color: { dark: "#000000", light: "#ffffff" },
      width: 400,
      margin: 2,
    });

    // Register QR token with given TTL
    activeSessions.set(qrToken, {
      ip: ipAddress,
      expiresAt: timestamp + ttl,
      dbSessionId: dbSessionId || null,
    });

    setTimeout(() => {
      activeSessions.delete(qrToken);
    }, ttl);

    const result = {
      qrImage: `/qrcodes/${fileName}`,
      qrToken,
      sessionId: dbSessionId || qrToken, // backward compat: sessionId alanı
      expiresIn: ttl,
    };

    // Cache with TTL metadata
    ipCache.set(ipAddress, {
      data: result,
      ttlMs: ttl,
      dbSessionId: dbSessionId || null,
      expiresAt: timestamp + ttl,
    });

    return result;
  } catch (error) {
    console.error("QR generation error:", error);
    throw error;
  }
}

/**
 * Validate a short-lived QR scan token.
 * Accepts either the new qrToken or legacy sessionId (backward compat).
 */
function validateSession(token) {
  const session = activeSessions.get(token);
  if (!session) return false;

  if (Date.now() > session.expiresAt) {
    activeSessions.delete(token);
    return false;
  }

  return true;
}

/**
 * Get the DB session ID associated with a QR token (if any).
 */
function getDbSessionId(qrToken) {
  const entry = activeSessions.get(qrToken);
  return entry ? entry.dbSessionId : null;
}

// Cleanup: 60 dakikadan eski qr_*.png dosyalarını sil
function cleanupOldQRCodes() {
  const now = Date.now();
  const MAX_AGE = 60 * 60 * 1000; // 60 dakika

  fs.readdir(QR_CODE_DIR, (err, files) => {
    if (err) {
      console.error("Cleanup error:", err);
      return;
    }

    files.forEach((file) => {
      if (file.startsWith("qr_") && file.endsWith(".png")) {
        const fileTimestamp = parseInt(file.split("_")[1].split(".")[0]);
        if (isNaN(fileTimestamp)) return;

        if (now - fileTimestamp > MAX_AGE) {
          fs.unlink(path.join(QR_CODE_DIR, file), (unlinkErr) => {
            if (unlinkErr) console.error("Error deleting file:", file, unlinkErr);
          });
        }
      }
    });
  });
}

setInterval(cleanupOldQRCodes, 5 * 60 * 1000);
cleanupOldQRCodes();

module.exports = {
  generateQRCode,
  validateSession,
  getDbSessionId,
};