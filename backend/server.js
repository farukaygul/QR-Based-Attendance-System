const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
require("dotenv").config();
const path = require("path");
const rateLimit = require("express-rate-limit");
const fs = require("fs");
const crypto = require("crypto");
const helmet = require("helmet");

// Import models and routes
const User = require("./models/User");
const Attendance = require("./models/Attendance");
const attendanceRoutes = require("./routes/attendance");
const { generateQRCode, validateSession } = require("./qr-generator");
const adminRoutes = require("./routes/adminRoutes");

// ENV validation
const requiredEnvVars = ["MONGO_URI", "LATITUDE", "LONGITUDE", "RADIUS", "QR_SECRET_KEY", "ADMIN_USERNAME", "ADMIN_PASSWORD", "JWT_SECRET"];
requiredEnvVars.forEach((envVar) => {
  if (!process.env[envVar]) {
    console.error(`${envVar} environment variable is required`);
    process.exit(1);
  }
});

const app = express();

// Configuration from ENV
const CLASS_LAT = parseFloat(process.env.LATITUDE);
const CLASS_LNG = parseFloat(process.env.LONGITUDE);
const MAX_DISTANCE_METERS = parseFloat(process.env.RADIUS);

const QR_CODE_DIR = process.env.QR_CODE_DIR || path.join(__dirname, "public/qrcodes");


// Middleware Setup
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "script-src": [
          "'self'",
          "https://cdn.tailwindcss.com",
          "https://cdn.jsdelivr.net",
          "'unsafe-inline'",
        ],
        "style-src": [
          "'self'",
          "https://fonts.googleapis.com",
          "https://cdn.jsdelivr.net",
          "https://cdnjs.cloudflare.com",
          "'unsafe-inline'",
        ],
        "font-src": [
          "'self'",
          "https://fonts.gstatic.com",
          "https://cdnjs.cloudflare.com",
        ],
        "img-src": ["'self'", "data:"],
      },
    },
  })
);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../frontend")));

// Request logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// QR Code Directory Setup
try {
  if (!fs.existsSync(QR_CODE_DIR)) {
    fs.mkdirSync(QR_CODE_DIR, { recursive: true });
    console.log(`Created QR code directory at: ${QR_CODE_DIR}`);
  }

  fs.readdir(QR_CODE_DIR, (err, files) => {
    if (err) {
      console.error("Startup cleanup error:", err);
      return;
    }
    const now = Date.now();
    files.forEach((file) => {
      if (file.startsWith("qr_") && file.endsWith(".png")) {
        const fileTimestamp = parseInt(file.split("_")[1].split(".")[0]);
        if (isNaN(fileTimestamp) || now - fileTimestamp > 60 * 60 * 1000) {
          fs.unlink(path.join(QR_CODE_DIR, file), (unlinkErr) => {
            if (unlinkErr) console.error("Error deleting file:", file, unlinkErr);
          });
        }
      }
    });
  });

  app.use(
    "/qrcodes",
    express.static(QR_CODE_DIR, {
      maxAge: "1h",
      setHeaders: (res) => {
        res.set("Cross-Origin-Resource-Policy", "cross-origin");
      },
    })
  );
  console.log(`Serving QR codes from: ${QR_CODE_DIR}`);
} catch (err) {
  console.error("Failed to setup QR code directory:", err);
  process.exit(1);
}

// Rate limiting for QR generation
const qrLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  handler: (req, res) => {
    console.log(`Rate limit exceeded for IP: ${req.ip}`);
    res.status(429).json({
      status: "error",
      message: "Too many QR requests. Please wait a minute.",
    });
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Routes
app.use("/api/attendance", attendanceRoutes);
app.use("/api/admin", adminRoutes);

// Get student info by roll number
app.get("/api/students/:rollNo", async (req, res) => {
  try {
    const { rollNo } = req.params;
    const student = await User.findOne({ universityRollNo: rollNo });
    if (!student) {
      return res.status(404).json({ status: "error", message: "Öğrenci bulunamadı" });
    }
    res.json({
      status: "success",
      data: {
        universityRollNo: student.universityRollNo,
        name: student.name,
        section: student.section,
        classRollNo: student.classRollNo,
      },
    });
  } catch (error) {
    console.error("Error fetching student:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// Attendance dates
app.get("/api/attendance/dates", async (req, res) => {
  try {
    const dates = await Attendance.find().distinct("date");
    res.json({ status: "success", data: dates });
  } catch (error) {
    console.error("Error fetching attendance dates:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// Attendance by date
app.get("/api/attendance/by-date", async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) {
      return res.status(400).json({ error: "Date parameter is required" });
    }
    const attendance = await Attendance.find({
      date: date,
      status: "present",
    }).sort({ universityRollNo: 1 });
    res.json({ status: "success", data: attendance });
  } catch (error) {
    console.error("Error fetching attendance by date:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// Student attendance records
app.get("/api/students/:rollNo/attendance", async (req, res) => {
  try {
    const { rollNo } = req.params;

    const attendance = await Attendance.find({ universityRollNo: rollNo }).sort({ date: -1 });

    const allDates = await Attendance.find().distinct("date");
    const totalClasses = allDates.length;
    const presentDays = attendance.filter((a) => a.status === "present").length;
    const percentage = totalClasses > 0 ? Math.round((presentDays / totalClasses) * 100) : 0;

    res.json({
      status: "success",
      data: {
        attendanceRecords: attendance,
        attendancePercentage: percentage,
        totalClasses: totalClasses,
        presentDays: presentDays,
      },
    });
  } catch (error) {
    console.error("Error fetching attendance:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// Students by attendance range
app.get("/api/students/by-attendance-range", async (req, res) => {
  try {
    const { min, max } = req.query;
    if (!min || !max) {
      return res.status(400).json({ error: "Both min and max percentage parameters are required" });
    }

    const minPercentage = parseFloat(min);
    const maxPercentage = parseFloat(max);

    if (isNaN(minPercentage) || isNaN(maxPercentage)) {
      return res.status(400).json({ error: "Percentages must be numbers" });
    }
    if (minPercentage < 0 || maxPercentage > 100) {
      return res.status(400).json({ error: "Percentages must be between 0 and 100" });
    }
    if (minPercentage > maxPercentage) {
      return res.status(400).json({ error: "Minimum percentage cannot be greater than maximum" });
    }

    const allDates = await Attendance.find().distinct("date");
    const totalClasses = allDates.length;

    if (totalClasses === 0) {
      return res.json({ status: "success", data: [] });
    }

    const results = await User.aggregate([
      {
        $lookup: {
          from: "attendances",
          let: { rollNo: "$universityRollNo" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$universityRollNo", "$$rollNo"] },
                    { $eq: ["$status", "present"] },
                  ],
                },
              },
            },
            { $count: "presentDays" },
          ],
          as: "attendance",
        },
      },
      {
        $addFields: {
          presentDays: { $ifNull: [{ $arrayElemAt: ["$attendance.presentDays", 0] }, 0] },
          totalClasses: totalClasses,
          attendancePercentage: {
            $round: [{
              $multiply: [{
                $divide: [
                  { $ifNull: [{ $arrayElemAt: ["$attendance.presentDays", 0] }, 0] },
                  totalClasses,
                ],
              }, 100],
            }],
          },
        },
      },
      {
        $match: {
          attendancePercentage: { $gte: minPercentage, $lte: maxPercentage },
        },
      },
      { $sort: { attendancePercentage: -1 } },
      {
        $project: {
          universityRollNo: 1,
          name: 1,
          section: 1,
          attendancePercentage: 1,
          presentDays: 1,
          totalClasses: 1,
          _id: 0,
        },
      },
    ]);

    res.json({ status: "success", data: results });
  } catch (error) {
    console.error("Error fetching students by attendance range:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// QR Code Generation
app.get("/api/generate-qr", qrLimiter, async (req, res) => {
  try {
    // TTL: query param → dakika → ms (min 1dk, max 60dk, varsayılan 5dk)
    let ttlMinutes = parseInt(req.query.ttlMinutes, 10);
    if (isNaN(ttlMinutes) || ttlMinutes < 1) ttlMinutes = 5;
    if (ttlMinutes > 60) ttlMinutes = 60;
    const ttlMs = ttlMinutes * 60 * 1000;

    console.log(`Generating QR code for IP: ${req.ip}, TTL: ${ttlMinutes} dk`);
    const qrData = await generateQRCode(req.ip, ttlMs);
    console.log(`Generated QR code at: ${qrData.qrImage}`);
    res.json({
      status: "success",
      qrImage: qrData.qrImage,
      sessionId: qrData.sessionId,
      expiresIn: qrData.expiresIn,
    });
  } catch (error) {
    console.error("QR generation error:", error);
    res.status(500).json({ status: "error", message: "QR üretilemedi. Lütfen tekrar deneyin." });
  }
});

// Session validation
app.post("/api/validate-session", (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) {
      return res.status(400).json({ valid: false, message: "Session ID required" });
    }
    const isValid = validateSession(sessionId);
    res.json({
      valid: isValid,
      message: isValid ? "Valid session" : "Invalid or expired session ID",
    });
  } catch (error) {
    console.error("Session validation error:", error);
    res.status(500).json({ valid: false, message: "Validation error" });
  }
});

// QR Verify & Redirect
app.get("/verify-attendance", (req, res) => {
  try {
    const dataStr = decodeURIComponent(req.query.data);
    const data = JSON.parse(dataStr);

    if (!data?.sessionId || !data?.timestamp || !data?.hash) {
      return res.status(400).send("Invalid QR code data: Missing fields");
    }

    const secretKey = process.env.QR_SECRET_KEY;
    const expectedHash = crypto
      .createHash("sha256")
      .update(data.sessionId + data.timestamp + secretKey)
      .digest("hex");

    if (data.hash !== expectedHash) {
      return res.status(400).send("Geçersiz QR kodu: Hash uyuşmuyor");
    }

    // Session bazlı süre kontrolü (TTL değişken olduğu için sabit süre yok)
    if (!validateSession(data.sessionId)) {
      return res.status(400).send("QR kodunun süresi dolmuş. Lütfen yeni bir QR kodu okutun.");
    }

    res.redirect(`/index.html?sessionId=${data.sessionId}`);
  } catch (error) {
    console.error("QR validation error:", error);
    res.status(400).send("Invalid QR code data");
  }
});

// Haversine distance (pure JS)
function getDistanceFromLatLngInMeters(lat1, lng1, lat2, lng2) {
  const toRad = (angle) => (angle * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Attendance validation middleware
function validateAttendance(req, res, next) {
  const required = ["universityRollNo", "deviceFingerprint", "sessionId"];
  const missing = required.filter((field) => !req.body[field]);

  if (missing.length) {
    return res.status(400).json({
      status: "error",
      message: `Eksik alanlar: ${missing.join(", ")}`,
    });
  }

  // universityRollNo: tam 9 haneli, sadece rakam
  const rollNo = req.body.universityRollNo;
  if (!/^\d{9}$/.test(rollNo)) {
    return res.status(400).json({
      status: "error",
      message: "Öğrenci numarası 9 haneli bir sayı olmalıdır.",
    });
  }

  if (
    !req.body.location ||
    typeof req.body.location.lat !== "number" ||
    typeof req.body.location.lng !== "number"
  ) {
    return res.status(400).json({
      status: "error",
      message: "Konum bilgisi (lat, lng) gereklidir.",
    });
  }
  next();
}

// Mark attendance
app.post("/mark-attendance", validateAttendance, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { universityRollNo, deviceFingerprint, location, sessionId: qrSessionId } = req.body;
    const today = new Date().toISOString().split("T")[0];

    // QR Session doğrulama (server-side)
    if (!validateSession(qrSessionId)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        status: "error",
        message: "QR oturumu geçersiz veya süresi dolmuş. Lütfen QR kodu tekrar okutun.",
      });
    }

    const [existing, existingDevice] = await Promise.all([
      Attendance.findOne({ universityRollNo, date: today }).session(session),
      Attendance.findOne({ deviceFingerprint, date: today }).session(session),
    ]);

    if (existing) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        status: "error",
        message: "Bugün yoklama zaten alınmış.",
      });
    }

    if (existingDevice) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        status: "error",
        message: "Bu cihazla bugün zaten yoklama girilmiş.",
      });
    }

    const distance = getDistanceFromLatLngInMeters(location.lat, location.lng, CLASS_LAT, CLASS_LNG);

    if (distance > MAX_DISTANCE_METERS) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        status: "error",
        message: `Derse ait konumun ${MAX_DISTANCE_METERS}m içinde olmalısınız. Mevcut uzaklık: ${distance.toFixed(0)}m`,
      });
    }

    // Öğrenciyi DB'den bul (upsert YOK — kayıtlı olmalı)
    const student = await User.findOne({ universityRollNo }).session(session);
    if (!student) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        status: "error",
        message: "Öğrenci sistemde kayıtlı değil. Lütfen öğretim elemanına/ders sorumlusuna bildiriniz.",
      });
    }

    const attendance = await Attendance.create(
      [{
        name: student.name,
        universityRollNo: student.universityRollNo,
        section: student.section,
        classRollNo: student.classRollNo,
        location: req.body.location,
        deviceFingerprint: req.body.deviceFingerprint,
        date: today,
        time: new Date().toLocaleTimeString("tr-TR", { hour12: false }),
        status: "present",
        studentId: student._id,
        distanceFromClass: distance,
      }],
      { session }
    );

    await session.commitTransaction();
    session.endSession();
    res.json({
      status: "success",
      message: "Yoklama başarıyla kaydedildi.",
      data: attendance[0],
    });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error("Yoklama hatası:", error);
    res.status(500).json({ status: "error", message: "Sunucu hatası. Lütfen tekrar deneyiniz." });
  }
});

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    dbState: mongoose.connection.readyState,
    uptime: process.uptime(),
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ status: "error", message: "Route not found" });
});

// Error handler
app.use((err, req, res, next) => {
  console.error("Server error:", err.message);
  res.status(500).json({ status: "error", message: "Internal server error" });
});

// Database Connection
mongoose
  .connect(process.env.MONGO_URI)
  .then(async () => {
    console.log("Connected to MongoDB");
    try {
      // Eski non-unique index'leri temizle, schema'daki unique index'ler otomatik oluşur
      const collection = mongoose.connection.collection("attendances");
      const existingIndexes = await collection.indexes();
      for (const idx of existingIndexes) {
        if (
          (idx.name === "student_date_attendance_idx" ||
           idx.name === "device_date_attendance_idx") &&
          !idx.unique
        ) {
          await collection.dropIndex(idx.name).catch(() => {});
          console.log(`Dropped old non-unique index: ${idx.name}`);
        }
      }
      await Attendance.syncIndexes();
      console.log("Indexes synced for Attendance.");
    } catch (err) {
      console.error("Index sync error:", err);
    }
  })
  .catch((err) => {
    console.error("MongoDB connection error:", err);
    process.exit(1);
  });

// Start Server
const PORT = process.env.PORT || 5050;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
