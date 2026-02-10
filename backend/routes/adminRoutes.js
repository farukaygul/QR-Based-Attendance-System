const express = require("express");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const mongoose = require("mongoose");
const multer = require("multer");
const { parse } = require("csv-parse/sync");
const { requireAdminAuth } = require("../middleware/adminAuth");
const User = require("../models/User");
const Attendance = require("../models/Attendance");
const Session = require("../models/Session");
const Settings = require("../models/Settings");

// Multer: memory storage, sadece .csv, max 2MB
const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (
      file.mimetype === "text/csv" ||
      file.originalname.toLowerCase().endsWith(".csv")
    ) {
      cb(null, true);
    } else {
      cb(new Error("Sadece .csv dosyaları kabul edilir."));
    }
  },
});

const router = express.Router();

// ═══════════════════════════════════════════════════
//  YARDIMCI
// ═══════════════════════════════════════════════════

const ROLL_RE = /^\d{9}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validateRollNo(rollNo) {
  return typeof rollNo === "string" && ROLL_RE.test(rollNo);
}

// ═══════════════════════════════════════════════════
//  AUTH  (login + me)
// ═══════════════════════════════════════════════════

const adminLoginLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  handler: (_req, res) => {
    res.status(429).json({
      status: "error",
      message: "Çok fazla giriş denemesi. Lütfen 5 dakika sonra tekrar deneyin.",
    });
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// POST /api/admin/login
router.post("/login", adminLoginLimiter, (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        status: "error",
        message: "Kullanıcı adı ve şifre gereklidir.",
      });
    }

    if (username !== process.env.ADMIN_USERNAME || password !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({
        status: "error",
        message: "Kullanıcı adı veya şifre hatalı.",
      });
    }

    const ttlHours = parseInt(process.env.ADMIN_TOKEN_TTL_HOURS, 10) || 24;
    const expiresInSeconds = ttlHours * 60 * 60;

    const token = jwt.sign({ sub: "admin" }, process.env.JWT_SECRET, {
      expiresIn: expiresInSeconds,
    });

    res.json({ status: "success", token, expiresInSeconds });
  } catch (error) {
    console.error("Admin login hatası:", error);
    res.status(500).json({ status: "error", message: "Sunucu hatası." });
  }
});

// GET /api/admin/me
router.get("/me", requireAdminAuth, (_req, res) => {
  res.json({ status: "success", data: { role: "admin" } });
});

// ═══════════════════════════════════════════════════
//  SETTINGS (singleton)
// ═══════════════════════════════════════════════════

// GET /api/admin/settings
router.get("/settings", requireAdminAuth, async (_req, res) => {
  try {
    const settings = await Settings.getSettings();
    res.json({ status: "success", data: settings });
  } catch (error) {
    console.error("Admin settings get hatası:", error);
    res.status(500).json({ status: "error", message: "Sunucu hatası." });
  }
});

// PUT /api/admin/settings
router.put("/settings", requireAdminAuth, async (req, res) => {
  try {
    const { orgTitle, courseTitle, requireLocation, classLat, classLng, radiusMeters } = req.body;
    const update = {};

    if (orgTitle !== undefined) update.orgTitle = String(orgTitle).trim();
    if (courseTitle !== undefined) update.courseTitle = String(courseTitle).trim();
    if (requireLocation !== undefined) update.requireLocation = Boolean(requireLocation);

    if (classLat !== undefined) {
      const lat = parseFloat(classLat);
      if (isNaN(lat)) return res.status(400).json({ status: "error", message: "classLat sayısal olmalıdır." });
      update.classLat = lat;
    }
    if (classLng !== undefined) {
      const lng = parseFloat(classLng);
      if (isNaN(lng)) return res.status(400).json({ status: "error", message: "classLng sayısal olmalıdır." });
      update.classLng = lng;
    }
    if (radiusMeters !== undefined) {
      const r = parseFloat(radiusMeters);
      if (isNaN(r) || r < 0) return res.status(400).json({ status: "error", message: "radiusMeters >= 0 olmalıdır." });
      update.radiusMeters = r;
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ status: "error", message: "Güncellenecek alan belirtilmedi." });
    }

    const settings = await Settings.findOneAndUpdate({}, { $set: update }, { new: true, upsert: true });
    res.json({ status: "success", data: settings });
  } catch (error) {
    console.error("Admin settings update hatası:", error);
    res.status(500).json({ status: "error", message: "Sunucu hatası." });
  }
});

// ═══════════════════════════════════════════════════
//  SESSIONS (yoklama oturumları)
// ═══════════════════════════════════════════════════

// POST /api/admin/sessions — yeni oturum başlat
router.post("/sessions", requireAdminAuth, async (req, res) => {
  try {
    const { title, policy, ttlMinutes, requireLocation } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ status: "error", message: "Oturum başlığı (title) zorunludur." });
    }

    let ttl = parseInt(ttlMinutes, 10) || 15;
    if (ttl < 1) ttl = 1;
    if (ttl > 1440) ttl = 1440;

    const validPolicies = ["whitelist", "open"];
    const sessionPolicy = validPolicies.includes(policy) ? policy : "whitelist";

    const sess = await Session.create({
      title: title.trim(),
      policy: sessionPolicy,
      requireLocation: requireLocation !== undefined ? Boolean(requireLocation) : true,
      expiresAt: new Date(Date.now() + ttl * 60 * 1000),
    });

    res.status(201).json({ status: "success", data: sess });
  } catch (error) {
    console.error("Admin session create hatası:", error);
    res.status(500).json({ status: "error", message: "Sunucu hatası." });
  }
});

// GET /api/admin/sessions/active — aktif oturum
router.get("/sessions/active", requireAdminAuth, async (_req, res) => {
  try {
    const sess = await Session.findActive();
    res.json({ status: "success", data: sess || null });
  } catch (error) {
    console.error("Admin session active hatası:", error);
    res.status(500).json({ status: "error", message: "Sunucu hatası." });
  }
});

// POST /api/admin/sessions/:id/close — oturumu kapat
router.post("/sessions/:id/close", requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ status: "error", message: "Geçersiz oturum ID." });
    }

    const sess = await Session.findByIdAndUpdate(id, { $set: { endAt: new Date() } }, { new: true });
    if (!sess) {
      return res.status(404).json({ status: "error", message: "Oturum bulunamadı." });
    }

    res.json({ status: "success", data: sess, message: "Oturum kapatıldı." });
  } catch (error) {
    console.error("Admin session close hatası:", error);
    res.status(500).json({ status: "error", message: "Sunucu hatası." });
  }
});

// ═══════════════════════════════════════════════════
//  STUDENTS CRUD
// ═══════════════════════════════════════════════════

// GET /api/admin/students/sections — benzersiz bölüm listesi
router.get("/students/sections", requireAdminAuth, async (_req, res) => {
  try {
    const sections = await User.distinct("section");
    const filtered = sections
      .filter((s) => typeof s === "string" && s.trim() !== "")
      .map((s) => s.trim())
      .sort((a, b) => a.localeCompare(b, "tr"));
    res.json({ status: "success", data: filtered });
  } catch (error) {
    console.error("Admin sections hatası:", error);
    res.status(500).json({ status: "error", message: "Sunucu hatası." });
  }
});

// DELETE /api/admin/students/purge — tüm öğrencileri kalıcı sil (X-Confirm: PURGE zorunlu)
router.delete("/students/purge", requireAdminAuth, async (req, res) => {
  try {
    if (req.headers["x-confirm"] !== "PURGE") {
      return res.status(400).json({
        status: "error",
        message: "Bu işlem için X-Confirm: PURGE başlığı gereklidir.",
      });
    }
    const result = await User.deleteMany({});
    res.json({
      status: "success",
      message: `${result.deletedCount} öğrenci kaydı silindi.`,
      deletedCount: result.deletedCount,
    });
  } catch (error) {
    console.error("Admin students purge hatası:", error);
    res.status(500).json({ status: "error", message: "Sunucu hatası." });
  }
});

// GET /api/admin/students?query=&section=&page=&limit=
router.get("/students", requireAdminAuth, async (req, res) => {
  try {
    const { query, section, page = 1, limit = 50 } = req.query;
    const p = Math.max(1, parseInt(page, 10) || 1);
    const l = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));

    const filter = {};

    if (query) {
      const q = query.trim();
      filter.$or = [
        { name: { $regex: q, $options: "i" } },
        { universityRollNo: { $regex: q, $options: "i" } },
      ];
    }

    if (section) {
      filter.section = section.trim();
    }

    const [students, total] = await Promise.all([
      User.find(filter)
        .sort({ universityRollNo: 1 })
        .skip((p - 1) * l)
        .limit(l)
        .lean(),
      User.countDocuments(filter),
    ]);

    res.json({
      status: "success",
      data: students,
      pagination: { page: p, limit: l, total, pages: Math.ceil(total / l) },
    });
  } catch (error) {
    console.error("Admin students list hatası:", error);
    res.status(500).json({ status: "error", message: "Sunucu hatası." });
  }
});

// GET /api/admin/students/:rollNo
router.get("/students/:rollNo", requireAdminAuth, async (req, res) => {
  try {
    const student = await User.findOne({ universityRollNo: req.params.rollNo }).lean();
    if (!student) {
      return res.status(404).json({ status: "error", message: "Öğrenci bulunamadı." });
    }
    res.json({ status: "success", data: student });
  } catch (error) {
    console.error("Admin student get hatası:", error);
    res.status(500).json({ status: "error", message: "Sunucu hatası." });
  }
});

// POST /api/admin/students
router.post("/students", requireAdminAuth, async (req, res) => {
  try {
    const { universityRollNo, name, section, classRollNo } = req.body;

    if (!universityRollNo || !name) {
      return res.status(400).json({
        status: "error",
        message: "Eksik alanlar: universityRollNo ve name zorunludur.",
      });
    }

    if (!validateRollNo(universityRollNo)) {
      return res.status(400).json({
        status: "error",
        message: "Öğrenci numarası 9 haneli bir sayı olmalıdır.",
      });
    }

    const existing = await User.findOne({ universityRollNo });
    if (existing) {
      return res.status(409).json({
        status: "error",
        message: "Bu öğrenci numarası zaten kayıtlı.",
      });
    }

    const student = await User.create({
      universityRollNo,
      name: name.trim(),
      section: section?.trim() || "",
      classRollNo: classRollNo?.trim() || universityRollNo,
    });

    res.status(201).json({ status: "success", data: student });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ status: "error", message: "Bu öğrenci numarası zaten kayıtlı." });
    }
    console.error("Admin student create hatası:", error);
    res.status(500).json({ status: "error", message: "Sunucu hatası." });
  }
});

// PUT /api/admin/students/:rollNo
router.put("/students/:rollNo", requireAdminAuth, async (req, res) => {
  try {
    const { name, section, classRollNo, universityRollNo: newRollNo } = req.body;

    const update = {};
    if (name !== undefined) update.name = name.trim();
    if (section !== undefined) update.section = section.trim();
    if (classRollNo !== undefined) update.classRollNo = classRollNo.trim();

    if (newRollNo !== undefined) {
      if (!validateRollNo(newRollNo)) {
        return res.status(400).json({
          status: "error",
          message: "Öğrenci numarası 9 haneli bir sayı olmalıdır.",
        });
      }
      update.universityRollNo = newRollNo;
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({
        status: "error",
        message: "Güncellenecek alan belirtilmedi.",
      });
    }

    const student = await User.findOneAndUpdate(
      { universityRollNo: req.params.rollNo },
      { $set: update },
      { new: true, runValidators: true }
    );

    if (!student) {
      return res.status(404).json({ status: "error", message: "Öğrenci bulunamadı." });
    }

    res.json({ status: "success", data: student });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ status: "error", message: "Bu öğrenci numarası zaten başka bir kayıtta mevcut." });
    }
    console.error("Admin student update hatası:", error);
    res.status(500).json({ status: "error", message: "Sunucu hatası." });
  }
});

// DELETE /api/admin/students/:rollNo
router.delete("/students/:rollNo", requireAdminAuth, async (req, res) => {
  try {
    const student = await User.findOneAndDelete({ universityRollNo: req.params.rollNo });
    if (!student) {
      return res.status(404).json({ status: "error", message: "Öğrenci bulunamadı." });
    }
    res.json({ status: "success", message: "Öğrenci başarıyla silindi." });
  } catch (error) {
    console.error("Admin student delete hatası:", error);
    res.status(500).json({ status: "error", message: "Sunucu hatası." });
  }
});

// ═══════════════════════════════════════════════════
//  STUDENTS CSV IMPORT
// ═══════════════════════════════════════════════════

// POST /api/admin/students/import
router.post("/students/import", requireAdminAuth, (req, res, next) => {
  csvUpload.single("file")(req, res, (err) => {
    if (err) {
      const msg =
        err instanceof multer.MulterError
          ? err.code === "LIMIT_FILE_SIZE"
            ? "Dosya boyutu 2MB'yi aşamaz."
            : "Dosya yükleme hatası."
          : err.message || "Dosya yükleme hatası.";
      return res.status(400).json({ status: "error", message: msg });
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        status: "error",
        message: "CSV dosyası gereklidir. 'file' alanıyla yükleyin.",
      });
    }

    let csvText = req.file.buffer.toString("utf-8");
    // BOM temizle
    if (csvText.charCodeAt(0) === 0xfeff) csvText = csvText.slice(1);

    // Delimiter otomatik algıla: ilk satırda ';' varsa Excel TR formatı
    const firstLine = csvText.split(/\r?\n/)[0];
    const delimiter = firstLine.includes(";") ? ";" : ",";

    let records;
    try {
      records = parse(csvText, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        bom: true,
        delimiter,
      });
    } catch (parseErr) {
      return res.status(400).json({
        status: "error",
        message: "CSV ayrıştırma hatası: " + parseErr.message,
      });
    }

    if (records.length === 0) {
      return res.status(400).json({
        status: "error",
        message: "CSV dosyası boş veya başlık satırı eksik.",
      });
    }

    if (records.length > 2000) {
      return res.status(400).json({
        status: "error",
        message: `Tek seferde en fazla 2000 satır yüklenebilir (gönderilen: ${records.length}).`,
      });
    }

    // Başlık kontrolü (universityRollNo ve name zorunlu, section opsiyonel)
    const firstKeys = Object.keys(records[0]).map((k) => k.toLowerCase());
    if (!firstKeys.includes("universityrollno") || !firstKeys.includes("name")) {
      return res.status(400).json({
        status: "error",
        message: "CSV başlıkları hatalı. Zorunlu sütunlar: universityRollNo, name (section opsiyonel)",
      });
    }

    const summary = { total: records.length, inserted: 0, updated: 0, skipped: 0, errors: 0 };
    const errors = [];

    for (let i = 0; i < records.length; i++) {
      const row = records[i];
      const rowNum = i + 2; // +2: 1-indexed + header satırı

      // Alanları normalize et (case-insensitive header desteği)
      const rollNo = (row.universityRollNo || row.universityrollno || row.UniversityRollNo || "").trim();
      const name = (row.name || row.Name || "").trim();
      const section = (row.section || row.Section || "").trim();

      // Validasyon
      if (!rollNo) {
        errors.push({ row: rowNum, universityRollNo: rollNo, reason: "Öğrenci numarası boş." });
        summary.errors++;
        continue;
      }

      if (!ROLL_RE.test(rollNo)) {
        errors.push({ row: rowNum, universityRollNo: rollNo, reason: "Öğrenci numarası 9 haneli bir sayı olmalıdır." });
        summary.errors++;
        continue;
      }

      if (!name) {
        errors.push({ row: rowNum, universityRollNo: rollNo, reason: "İsim boş." });
        summary.errors++;
        continue;
      }

      try {
        const result = await User.findOneAndUpdate(
          { universityRollNo: rollNo },
          { $set: { name, section, universityRollNo: rollNo } },
          { upsert: true, new: true, setDefaultsOnInsert: true, rawResult: true }
        );

        if (result.lastErrorObject?.updatedExisting) {
          summary.updated++;
        } else {
          summary.inserted++;
        }
      } catch (dbErr) {
        errors.push({ row: rowNum, universityRollNo: rollNo, reason: dbErr.message });
        summary.errors++;
      }
    }

    summary.skipped = summary.total - summary.inserted - summary.updated - summary.errors;

    res.json({ status: "success", summary, errors });
  } catch (error) {
    console.error("CSV import hatası:", error);
    res.status(500).json({ status: "error", message: "Sunucu hatası." });
  }
});

// ═══════════════════════════════════════════════════
//  ATTENDANCE CRUD
// ═══════════════════════════════════════════════════

// GET /api/admin/attendance?date=&rollNo=&page=&limit=
router.get("/attendance", requireAdminAuth, async (req, res) => {
  try {
    const { date, rollNo, status, page = 1, limit = 50 } = req.query;
    const p = Math.max(1, parseInt(page, 10) || 1);
    const l = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));

    const filter = {};
    if (date) filter.date = date;
    if (rollNo) filter.universityRollNo = rollNo;
    if (status) filter.status = status;

    const [records, total] = await Promise.all([
      Attendance.find(filter)
        .sort({ date: -1, universityRollNo: 1 })
        .skip((p - 1) * l)
        .limit(l)
        .lean(),
      Attendance.countDocuments(filter),
    ]);

    res.json({
      status: "success",
      data: records,
      pagination: { page: p, limit: l, total, pages: Math.ceil(total / l) },
    });
  } catch (error) {
    console.error("Admin attendance list hatası:", error);
    res.status(500).json({ status: "error", message: "Sunucu hatası." });
  }
});

// POST /api/admin/attendance/manual
router.post("/attendance/manual", requireAdminAuth, async (req, res) => {
  try {
    const { universityRollNo, date, time, status = "present", note, sessionId } = req.body;

    // Validasyonlar
    if (!universityRollNo || !date) {
      return res.status(400).json({
        status: "error",
        message: "Eksik alanlar: universityRollNo ve date zorunludur.",
      });
    }

    if (!sessionId) {
      return res.status(400).json({
        status: "error",
        message: "Oturum ID (sessionId) zorunludur. Önce bir oturum başlatın.",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(sessionId)) {
      return res.status(400).json({
        status: "error",
        message: "Geçersiz oturum ID.",
      });
    }

    if (!validateRollNo(universityRollNo)) {
      return res.status(400).json({
        status: "error",
        message: "Öğrenci numarası 9 haneli bir sayı olmalıdır.",
      });
    }

    if (!DATE_RE.test(date)) {
      return res.status(400).json({
        status: "error",
        message: "Tarih formatı hatalı. YYYY-MM-DD formatında olmalıdır.",
      });
    }

    // Session var mı ve aktif mi?
    const sess = await Session.findById(sessionId);
    if (!sess) {
      return res.status(400).json({
        status: "error",
        message: "Oturum bulunamadı. Geçerli bir oturum ID gönderin.",
      });
    }
    if (sess.endAt !== null && sess.endAt !== undefined) {
      return res.status(400).json({
        status: "error",
        message: "Oturum aktif değil (kapatılmış).",
      });
    }
    if (sess.expiresAt <= new Date()) {
      return res.status(400).json({
        status: "error",
        message: "Oturum aktif değil (süresi dolmuş).",
      });
    }

    // Policy kontrolü
    let attName = "";
    let attSection = "";
    let attClassRollNo = "";
    let attStudentId = null;

    const student = await User.findOne({ universityRollNo });

    if (sess.policy === "whitelist") {
      if (!student) {
        return res.status(400).json({
          status: "error",
          message: "Öğrenci sistemde kayıtlı değil. Önce öğrenciyi ekleyin.",
        });
      }
      attName = student.name;
      attSection = student.section || "";
      attClassRollNo = student.classRollNo || "";
      attStudentId = student._id;
    } else {
      // open policy
      if (student) {
        attName = student.name;
        attSection = student.section || "";
        attClassRollNo = student.classRollNo || "";
        attStudentId = student._id;
      } else {
        if (!req.body.name || !req.body.name.trim()) {
          return res.status(400).json({
            status: "error",
            message: "Open oturumda isim (name) zorunludur.",
          });
        }
        attName = req.body.name.trim();
      }
    }

    // Aynı session + aynı öğrenci kontrolü
    const dup = await Attendance.findOne({ sessionId, universityRollNo });
    if (dup) {
      return res.status(409).json({
        status: "error",
        message: "Bu oturumda bu öğrenci için yoklama zaten mevcut.",
      });
    }

    const record = await Attendance.create({
      sessionId,
      name: attName,
      universityRollNo,
      section: attSection,
      classRollNo: attClassRollNo,
      date,
      time: time || new Date().toLocaleTimeString("tr-TR", { hour12: false }),
      status,
      studentId: attStudentId || undefined,
      manual: true,
      note: note || undefined,
      distanceFromClass: null,
    });

    res.status(201).json({ status: "success", data: record });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        status: "error",
        message: "Bu oturumda bu öğrenci için yoklama zaten mevcut.",
      });
    }
    if (error.name === "ValidationError") {
      const msgs = Object.values(error.errors).map((e) => e.message);
      return res.status(400).json({
        status: "error",
        message: "Manuel kayıt için zorunlu alan hatası: " + msgs.join(", "),
      });
    }
    console.error("Admin manual attendance hatası:", error);
    res.status(500).json({ status: "error", message: "Sunucu hatası." });
  }
});

// DELETE /api/admin/attendance/purge — tüm yoklama kayıtlarını kalıcı sil (X-Confirm: PURGE zorunlu)
router.delete("/attendance/purge", requireAdminAuth, async (req, res) => {
  try {
    if (req.headers["x-confirm"] !== "PURGE") {
      return res.status(400).json({
        status: "error",
        message: "Bu işlem için X-Confirm: PURGE başlığı gereklidir.",
      });
    }
    const result = await Attendance.deleteMany({});
    res.json({
      status: "success",
      message: `${result.deletedCount} yoklama kaydı silindi.`,
      deletedCount: result.deletedCount,
    });
  } catch (error) {
    console.error("Admin attendance purge hatası:", error);
    res.status(500).json({ status: "error", message: "Sunucu hatası." });
  }
});

// PUT /api/admin/attendance/:id
router.put("/attendance/:id", requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ status: "error", message: "Geçersiz kayıt ID." });
    }

    const { name, section, classRollNo, status, time, date, note } = req.body;
    const update = {};
    if (name !== undefined) update.name = name.trim();
    if (section !== undefined) update.section = section.trim();
    if (classRollNo !== undefined) update.classRollNo = classRollNo.trim();
    if (status !== undefined) update.status = status;
    if (time !== undefined) update.time = time;
    if (note !== undefined) update.note = note;

    if (date !== undefined) {
      if (!DATE_RE.test(date)) {
        return res.status(400).json({
          status: "error",
          message: "Tarih formatı hatalı. YYYY-MM-DD formatında olmalıdır.",
        });
      }
      update.date = date;
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({
        status: "error",
        message: "Güncellenecek alan belirtilmedi.",
      });
    }

    const record = await Attendance.findByIdAndUpdate(id, { $set: update }, { new: true });
    if (!record) {
      return res.status(404).json({ status: "error", message: "Yoklama kaydı bulunamadı." });
    }

    res.json({ status: "success", data: record });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        status: "error",
        message: "Bu güncelleme bir çakışmaya neden oluyor (aynı öğrenci + aynı tarih).",
      });
    }
    console.error("Admin attendance update hatası:", error);
    res.status(500).json({ status: "error", message: "Sunucu hatası." });
  }
});

// DELETE /api/admin/attendance/:id
router.delete("/attendance/:id", requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ status: "error", message: "Geçersiz kayıt ID." });
    }

    const record = await Attendance.findByIdAndDelete(id);
    if (!record) {
      return res.status(404).json({ status: "error", message: "Yoklama kaydı bulunamadı." });
    }

    res.json({ status: "success", message: "Yoklama kaydı başarıyla silindi." });
  } catch (error) {
    console.error("Admin attendance delete hatası:", error);
    res.status(500).json({ status: "error", message: "Sunucu hatası." });
  }
});

module.exports = router;