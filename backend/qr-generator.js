const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// Configuration
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 dakika varsayılan
const QR_CODE_DIR =
  process.env.QR_CODE_DIR || path.join(__dirname, "public", "qrcodes");

// Track active sessions and IP cache
const activeSessions = new Map();
const ipCache = new Map();

// Ensure QR code directory exists
if (!fs.existsSync(QR_CODE_DIR)) {
  fs.mkdirSync(QR_CODE_DIR, { recursive: true });
}

/**
 * @param {string} ipAddress
 * @param {number} [ttlMs] — session TTL in milliseconds (default 5 min)
 */
async function generateQRCode(ipAddress, ttlMs) {
  const ttl = typeof ttlMs === "number" && ttlMs > 0 ? ttlMs : DEFAULT_TTL_MS;

  // Check cache — bypass if TTL changed
  if (ipCache.has(ipAddress)) {
    const cached = ipCache.get(ipAddress);
    const remaining = cached.expiresAt - Date.now();
    if (remaining > 0 && cached.ttlMs === ttl) {
      // Return cached result with updated remaining time
      return { ...cached.data, expiresIn: remaining };
    }
  }

  try {
    const sessionId = crypto.randomBytes(16).toString("hex");
    const timestamp = Date.now();

    const secretKey = process.env.QR_SECRET_KEY || "default-secret-key";
    const hash = crypto
      .createHash("sha256")
      .update(sessionId + timestamp + secretKey)
      .digest("hex");

    const baseUrl =
      process.env.BASE_URL ||
      `http://localhost:${process.env.PORT || 5050}`;

    const qrData = `${baseUrl}/verify-attendance?data=${encodeURIComponent(
      JSON.stringify({ sessionId, timestamp, hash })
    )}`;

    const fileName = `qr_${timestamp}.png`;
    const filePath = path.join(QR_CODE_DIR, fileName);

    await QRCode.toFile(filePath, qrData, {
      color: { dark: "#000000", light: "#ffffff" },
      width: 400,
      margin: 2,
    });

    // Register session with given TTL
    activeSessions.set(sessionId, {
      ip: ipAddress,
      expiresAt: timestamp + ttl,
    });

    setTimeout(() => {
      activeSessions.delete(sessionId);
    }, ttl);

    const result = {
      qrImage: `/qrcodes/${fileName}`,
      sessionId,
      expiresIn: ttl,
    };

    // Cache with TTL metadata
    ipCache.set(ipAddress, {
      data: result,
      ttlMs: ttl,
      expiresAt: timestamp + ttl,
    });

    return result;
  } catch (error) {
    console.error("QR generation error:", error);
    throw error;
  }
}

function validateSession(sessionId) {
  const session = activeSessions.get(sessionId);
  if (!session) return false;

  if (Date.now() > session.expiresAt) {
    activeSessions.delete(sessionId);
    return false;
  }

  return true;
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
};