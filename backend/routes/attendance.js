const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const Attendance = require("../models/Attendance");
const User = require("../models/User");

// GET student attendance records
router.get('/', async (req, res) => {
  try {
    const { rollNo } = req.query;

    if (!rollNo) {
      return res.status(400).json({ message: "Roll number is required" });
    }

    // Get student info
    const student = await User.findOne({ universityRollNo: rollNo });
    if (!student) {
      return res.status(404).json({ message: "Student not found" });
    }

    // Get attendance records
    const attendance = await Attendance.find({ universityRollNo: rollNo })
      .sort({ date: -1, time: -1 });

    res.json({
      status: "success",
      name: student.name,
      universityRollNo: student.universityRollNo,
      attendance
    });
  } catch (error) {
    console.error("Attendance fetch error:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// GET /api/attendance/by-id/:attendanceId — tek kayıt (academic/guest dashboard için)
router.get('/by-id/:attendanceId', async (req, res) => {
  try {
    const { attendanceId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(attendanceId)) {
      return res.status(400).json({ status: "error", message: "Geçersiz kayıt ID." });
    }

    const att = await Attendance.findById(attendanceId).lean();
    if (!att) {
      return res.status(404).json({ status: "error", message: "Kayıt bulunamadı." });
    }

    res.json({ status: "success", data: att });
  } catch (err) {
    console.error("Attendance by-id hatası:", err);
    res.status(500).json({ status: "error", message: "Sunucu hatası." });
  }
});

module.exports = router;